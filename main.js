/*
  Debate Club Hub frontend logic (production-hardened pass)
  - Supabase auth + role-aware routing
  - Member feed with batch attendance lookup (avoids N+1 queries)
  - Admin CRUD with client-side validation and safer UI feedback
  - Realtime discussion chat with moderation support
*/

const APP_CONFIG = {
  supabaseUrl: window.SUPABASE_URL || 'https://otxicrplmjfydhfzpriv.supabase.co',
  supabaseAnonKey: window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90eGljcnBsbWpmeWRoZnpwcml2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NTYzMjgsImV4cCI6MjA4OTIzMjMyOH0.GY7td6uECBfttZ2ii82h2utH8dqB0F55iACr1qb5mds',
  maxTextLength: 2000
};

const supabaseClient = window.supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey);
const page = document.body?.dataset?.page;
const state = {
  currentUser: null,
  currentProfile: null,
  events: [],
  posts: [],
  attendanceSet: new Set(),
  activeFilter: 'all',
  realtimeChannel: null,
  qrScanner: null
};

const sanitizeText = (unsafe = '') =>
  String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const formatDate = (value) => new Date(value).toLocaleString();
const toISO = (value) => new Date(value).toISOString();
const setVisible = (id, show) => document.getElementById(id)?.classList.toggle('hidden', !show);

function isValidRegNo(regNo) {
  return /^[a-z0-9_-]{4,30}$/i.test(regNo);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function notify(message, type = 'info') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;right:16px;bottom:16px;display:grid;gap:8px;z-index:9999';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  const bg = type === 'error' ? '#fee2e2' : type === 'success' ? '#dcfce7' : '#e0e7ff';
  const color = type === 'error' ? '#991b1b' : type === 'success' ? '#166534' : '#3730a3';
  toast.style.cssText = `padding:10px 12px;border-radius:10px;background:${bg};color:${color};box-shadow:0 10px 24px rgba(15,23,42,.12);max-width:300px;font-weight:600`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function setButtonLoading(button, isLoading) {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalText = button.textContent;
    button.textContent = 'Processing...';
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
  }
  button.disabled = isLoading;
}

async function safeRequest(promise, errorPrefix = 'Request failed') {
  const result = await promise;
  if (result.error) throw new Error(`${errorPrefix}: ${result.error.message}`);
  return result;
}

async function bootstrap() {
  if (!APP_CONFIG.supabaseUrl.startsWith('http')) {
    notify('Set SUPABASE_URL and SUPABASE_ANON_KEY before using the app.', 'error');
    return;
  }

  try {
    const { data } = await supabaseClient.auth.getSession();
    state.currentUser = data.session?.user || null;

    if (page === 'member') await initMemberPage();
    if (page === 'admin') await initAdminPage();
    if (page === 'discussion') await initDiscussionPage();

    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
      await supabaseClient.auth.signOut();
      window.location.href = page === 'admin' ? 'admin.html' : 'index.html';
    });
  } catch (err) {
    notify(err.message || 'Failed to initialize app', 'error');
  }
}

async function loadProfile() {
  if (!state.currentUser) return null;
  const { data, error } = await supabaseClient.from('users').select('*').eq('id', state.currentUser.id).single();
  if (error) return null;
  state.currentProfile = data;
  return data;
}

/* ---------------- Member dashboard ---------------- */
async function initMemberPage() {
  document.getElementById('memberLoginForm')?.addEventListener('submit', memberLogin);
  document.getElementById('memberSignupForm')?.addEventListener('submit', memberSignup);

  const loginForm = document.getElementById('memberLoginForm');
  const signupForm = document.getElementById('memberSignupForm');
  document.getElementById('showMemberLoginBtn')?.addEventListener('click', () => {
    loginForm?.classList.remove('hidden');
    signupForm?.classList.add('hidden');
  });
  document.getElementById('showMemberSignupBtn')?.addEventListener('click', () => {
    signupForm?.classList.remove('hidden');
    loginForm?.classList.add('hidden');
  });

  if (state.currentUser) {
    const profile = await loadProfile();
    if (profile?.role === 'admin') {
      window.location.href = 'admin.html';
      return;
    }
    if (profile) await showMemberDashboard();
  }
}

async function memberLogin(e) {
  e.preventDefault();
  const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
  const email = document.getElementById('memberEmail').value.trim().toLowerCase();
  const password = document.getElementById('memberPassword').value;

  if (!isValidEmail(email) || password.length < 8) {
    notify('Use a valid email and password (minimum 8 characters).', 'error');
    return;
  }

  setButtonLoading(submitBtn, true);
  try {
    await safeRequest(supabaseClient.auth.signInWithPassword({ email, password }), 'Sign-in failed');
    state.currentUser = (await supabaseClient.auth.getUser()).data.user;
    const profile = await loadProfile();
    if (!profile) throw new Error('Account profile not found. Contact admin.');

    if (profile.role === 'admin') {
      window.location.href = 'admin.html';
      return;
    }

    await showMemberDashboard();
    notify('Welcome back!', 'success');
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

async function memberSignup(e) {
  e.preventDefault();
  const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
  const name = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim().toLowerCase();
  const regNo = document.getElementById('signupRegNo').value.trim().toLowerCase();
  const password = document.getElementById('signupPassword').value;

  if (!name || !isValidEmail(email) || !isValidRegNo(regNo) || password.length < 8) {
    notify('Provide valid name, email, registration number, and strong password.', 'error');
    return;
  }

  setButtonLoading(submitBtn, true);
  try {
    await safeRequest(
      supabaseClient.auth.signUp({
        email,
        password,
        options: {
          data: {
            name,
            reg_no: regNo,
            role: 'member'
          }
        }
      }),
      'Account creation failed'
    );

    notify('Account created successfully. Please sign in with your email and password.', 'success');
    e.currentTarget.reset();
    document.getElementById('showMemberLoginBtn')?.click();
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

async function showMemberDashboard() {
  setVisible('memberAuthSection', false);
  setVisible('memberDashboard', true);
  setVisible('logoutBtn', true);
  await refreshMemberData();
  bindFeedFilters();
}

async function refreshMemberData() {
  await Promise.all([loadFeed(state.activeFilter), loadMemberStats()]);
}

async function fetchAttendanceSet(eventIds = []) {
  state.attendanceSet = new Set();
  if (!state.currentUser || eventIds.length === 0) return;

  const { data, error } = await supabaseClient
    .from('attendance')
    .select('event_id')
    .eq('user_id', state.currentUser.id)
    .in('event_id', eventIds);

  if (error) return;
  (data || []).forEach((r) => state.attendanceSet.add(r.event_id));
}

async function loadFeed(filter = 'all') {
  state.activeFilter = filter;
  const grid = document.getElementById('feedGrid');
  grid.innerHTML = '<article class="panel"><p class="muted">Loading feed...</p></article>';

  try {
    const [{ data: events }, { data: posts }] = await Promise.all([
      safeRequest(supabaseClient.from('events').select('*').order('date_time', { ascending: false }), 'Could not fetch events'),
      safeRequest(
        supabaseClient.from('posts').select('*, users(name)').order('created_at', { ascending: false }),
        'Could not fetch posts'
      )
    ]);

    state.events = events || [];
    state.posts = posts || [];
    await fetchAttendanceSet(state.events.map((e) => e.id));

    const now = new Date();
    const feed = [];

    state.events.forEach((ev) => {
      const isPast = new Date(ev.date_time) < now;
      if (filter === 'upcoming' && isPast) return;
      if (filter === 'past' && !isPast) return;
      if (filter === 'discussion') return;
      feed.push({ type: 'event', ...ev });
    });

    state.posts.forEach((post) => {
      if (filter !== 'all' && filter !== 'discussion') return;
      if (filter === 'discussion' && post.type !== 'discussion') return;
      feed.push({ type: 'post', ...post });
    });

    feed.sort((a, b) => new Date(b.created_at || b.date_time) - new Date(a.created_at || a.date_time));
    renderFeed(feed);
  } catch (err) {
    grid.innerHTML = `<article class="panel"><p class="muted">${sanitizeText(err.message)}</p></article>`;
  }
}

function renderFeed(feed) {
  const grid = document.getElementById('feedGrid');
  grid.innerHTML = '';

  if (!feed.length) {
    grid.innerHTML = '<article class="panel"><p class="muted">No content found for this filter.</p></article>';
    return;
  }

  feed.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'card';

    if (item.type === 'event') {
      const attended = state.attendanceSet.has(item.id);
      card.innerHTML = `
        <img src="${sanitizeText(item.image_url || 'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?q=80&w=1400')}" alt="${sanitizeText(item.topic)}" loading="lazy" />
        <div class="card-content">
          <h3 class="card-title">${sanitizeText(item.topic)}</h3>
          <p class="muted">${formatDate(item.date_time)}</p>
          <p>${sanitizeText(item.description || '')}</p>
          <div class="card-actions">
            <button class="btn btn-primary" data-scan="${item.id}">Scan QR to Mark Attendance</button>
            <button class="btn btn-secondary" data-view-event="${item.id}">Details</button>
            <span class="badge ${attended ? 'success' : 'danger'}">${attended ? 'Attended' : 'Not Attended'}</span>
          </div>
        </div>`;
    } else {
      card.innerHTML = `
        <img src="https://images.unsplash.com/photo-1450101499163-c8848c66ca85?q=80&w=1400" alt="Discussion" loading="lazy" />
        <div class="card-content">
          <h3 class="card-title">${sanitizeText(item.title)}</h3>
          <p class="muted">${sanitizeText(item.users?.name || 'Club Team')} · ${formatDate(item.created_at)}</p>
          <p>${sanitizeText(item.content)}</p>
          <div class="card-actions">
            <span class="badge info">${item.type === 'discussion' ? 'New Discussion' : 'Notice'}</span>
            ${item.type === 'discussion' ? `<a class="btn btn-primary" href="discussion.html?post=${item.id}">Join Discussion</a>` : ''}
          </div>
        </div>`;
    }

    grid.appendChild(card);
  });

  grid.querySelectorAll('[data-scan]').forEach((btn) => btn.addEventListener('click', openScanner));
  grid.querySelectorAll('[data-view-event]').forEach((btn) => btn.addEventListener('click', openEventModal));
}

async function loadMemberStats() {
  if (!state.currentUser) return;
  const [eventsRes, attendanceRes, discussionRes] = await Promise.all([
    supabaseClient.from('events').select('id,date_time'),
    supabaseClient.from('attendance').select('event_id').eq('user_id', state.currentUser.id),
    supabaseClient.from('posts').select('id').eq('type', 'discussion')
  ]);

  const totalEvents = eventsRes.data?.length || 0;
  const attendedCount = attendanceRes.data?.length || 0;
  const attendancePct = totalEvents ? Math.round((attendedCount / totalEvents) * 100) : 0;
  const now = new Date();
  const upcomingCount = (eventsRes.data || []).filter((ev) => new Date(ev.date_time) >= now).length;

  document.getElementById('attendancePercent').textContent = `${attendancePct}%`;
  document.getElementById('upcomingCount').textContent = upcomingCount;
  document.getElementById('discussionCount').textContent = discussionRes.data?.length || 0;
}

function bindFeedFilters() {
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      await loadFeed(chip.dataset.filter);
    });
  });
}

async function openScanner(e) {
  const eventId = e.currentTarget.dataset.scan;
  const modal = document.getElementById('qrScannerModal');
  const status = document.getElementById('scannerStatus');
  status.textContent = 'Align event QR code within the frame.';
  modal.showModal();

  try {
    state.qrScanner = new Html5Qrcode('qrReader');
    const onScan = async (decodedText) => {
      try {
        const payload = JSON.parse(decodedText);
        if (payload.event_id !== eventId) throw new Error('This QR is for another event.');

        await safeRequest(
          supabaseClient.rpc('mark_attendance_from_qr', { p_event_id: payload.event_id, p_qr_token: payload.token }),
          'Attendance marking failed'
        );

        status.textContent = 'Attendance marked successfully.';
        notify('Attendance marked successfully.', 'success');
        await refreshMemberData();
        await closeScanner();
      } catch (err) {
        status.textContent = err.message;
      }
    };

    await state.qrScanner.start({ facingMode: 'environment' }, { fps: 8, qrbox: 220 }, onScan);
  } catch (err) {
    status.textContent = `Unable to start scanner: ${err.message}`;
  }

  document.getElementById('closeScannerBtn').onclick = closeScanner;
}

async function closeScanner() {
  if (state.qrScanner) {
    await state.qrScanner.stop().catch(() => null);
    await state.qrScanner.clear().catch(() => null);
    state.qrScanner = null;
  }
  document.getElementById('qrScannerModal').close();
}

function openEventModal(e) {
  const id = e.currentTarget.dataset.viewEvent;
  const event = state.events.find((it) => it.id === id);
  if (!event) return;

  document.getElementById('modalContent').innerHTML = `
    <h2>${sanitizeText(event.topic)}</h2>
    <p class="muted">${formatDate(event.date_time)}</p>
    <img style="width:100%;border-radius:10px" src="${sanitizeText(event.image_url)}" alt="${sanitizeText(event.topic)}" loading="lazy" />
    <p style="margin-top:12px">${sanitizeText(event.description || '')}</p>`;

  const modal = document.getElementById('eventModal');
  modal.showModal();
  document.getElementById('closeModalBtn').onclick = () => modal.close();
}

/* ---------------- Admin dashboard ---------------- */
async function initAdminPage() {
  document.getElementById('adminLoginForm')?.addEventListener('submit', adminLogin);

  if (state.currentUser) {
    const profile = await loadProfile();
    if (profile?.role === 'admin') {
      await showAdminDashboard();
    } else {
      await supabaseClient.auth.signOut();
      notify('Unauthorized session. Please sign in as admin.', 'error');
    }
  }
}

async function adminLogin(e) {
  e.preventDefault();
  const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
  const email = document.getElementById('adminEmail').value.trim();
  const regNo = document.getElementById('adminRegNo').value.trim();
  const password = document.getElementById('adminPassword').value;

  if (!email || !password || !isValidRegNo(regNo)) {
    notify('Please provide valid admin credentials.', 'error');
    return;
  }

  setButtonLoading(submitBtn, true);
  try {
    await safeRequest(supabaseClient.auth.signInWithPassword({ email, password }), 'Sign-in failed');

    state.currentUser = (await supabaseClient.auth.getUser()).data.user;
    const profile = await loadProfile();

    if (!profile || profile.role !== 'admin' || profile.reg_no !== regNo) {
      await supabaseClient.auth.signOut();
      throw new Error('Unauthorized admin credentials.');
    }

    await showAdminDashboard();
    notify('Admin signed in.', 'success');
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

async function showAdminDashboard() {
  setVisible('adminAuthSection', false);
  setVisible('adminDashboard', true);
  setVisible('logoutBtn', true);
  bindAdminForms();
  await Promise.all([loadEventsAdmin(), loadMembers(), loadPosts()]);
}

function bindAdminForms() {
  document.getElementById('eventForm').addEventListener('submit', saveEvent);
  document.getElementById('memberForm').addEventListener('submit', saveMember);
  document.getElementById('postForm').addEventListener('submit', savePost);
  document.getElementById('manualAttendanceForm').addEventListener('submit', manualAttendance);
  document.getElementById('downloadCsvBtn').addEventListener('click', downloadAttendanceCSV);
  document.getElementById('generateReportBtn').addEventListener('click', generatePrintableReport);
  document.getElementById('generateCertificatesBtn').addEventListener('click', generateCertificates);
}

function randomToken() {
  return crypto.getRandomValues(new Uint32Array(4)).join('-');
}

async function saveEvent(e) {
  e.preventDefault();
  const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
  const id = document.getElementById('eventId').value || undefined;
  const topic = document.getElementById('eventTopic').value.trim();
  const dateTime = document.getElementById('eventDateTime').value;
  const imageUrl = document.getElementById('eventImage').value.trim();
  const description = document.getElementById('eventDescription').value.trim();
  const expiryMins = Number(document.getElementById('eventExpiry').value || 120);

  if (!topic || !dateTime || !isValidUrl(imageUrl) || description.length > APP_CONFIG.maxTextLength) {
    notify('Please provide valid event inputs.', 'error');
    return;
  }

  setButtonLoading(submitBtn, true);
  try {
    const payload = {
      topic,
      date_time: toISO(dateTime),
      image_url: imageUrl,
      description,
      qr_token: randomToken(),
      token_expiry: new Date(Date.now() + expiryMins * 60_000).toISOString()
    };

    const query = id ? supabaseClient.from('events').update(payload).eq('id', id) : supabaseClient.from('events').insert(payload);
    await safeRequest(query, 'Saving event failed');

    e.target.reset();
    document.getElementById('eventId').value = '';
    await loadEventsAdmin();
    notify('Event saved.', 'success');
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

async function loadEventsAdmin() {
  const { data, error } = await supabaseClient.from('events').select('*').order('date_time', { ascending: false });
  if (error) {
    notify(error.message, 'error');
    return;
  }

  const list = document.getElementById('eventList');
  const postEvent = document.getElementById('postEvent');
  const manualEvent = document.getElementById('manualEvent');
  list.innerHTML = '';
  postEvent.innerHTML = '<option value="">None</option>';
  manualEvent.innerHTML = '';

  (data || []).forEach((ev) => {
    const qrPayload = JSON.stringify({ event_id: ev.id, token: ev.qr_token });
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div>
        <strong>${sanitizeText(ev.topic)}</strong>
        <p class="muted">${formatDate(ev.date_time)}</p>
        <p class="muted">Token expires: ${formatDate(ev.token_expiry)}</p>
        <canvas id="qr-${ev.id}" width="90" height="90"></canvas>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary" data-edit-event="${ev.id}">Edit</button>
        <button class="btn btn-danger" data-delete-event="${ev.id}">Delete</button>
      </div>`;
    list.appendChild(item);

    if (window.QRCode) QRCode.toCanvas(document.getElementById(`qr-${ev.id}`), qrPayload, { width: 90 });

    postEvent.innerHTML += `<option value="${ev.id}">${sanitizeText(ev.topic)}</option>`;
    manualEvent.innerHTML += `<option value="${ev.id}">${sanitizeText(ev.topic)}</option>`;
  });

  if (!data?.length) {
    list.innerHTML = '<p class="muted">No events available yet.</p>';
  }

  list.querySelectorAll('[data-delete-event]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await supabaseClient.from('events').delete().eq('id', btn.dataset.deleteEvent);
      await loadEventsAdmin();
      notify('Event deleted.', 'success');
    })
  );

  list.querySelectorAll('[data-edit-event]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const ev = data.find((x) => x.id === btn.dataset.editEvent);
      if (!ev) return;
      document.getElementById('eventId').value = ev.id;
      document.getElementById('eventTopic').value = ev.topic;
      document.getElementById('eventDateTime').value = new Date(ev.date_time).toISOString().slice(0, 16);
      document.getElementById('eventImage').value = ev.image_url;
      document.getElementById('eventDescription').value = ev.description || '';
    })
  );
}

async function saveMember(e) {
  e.preventDefault();
  const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
  const id = document.getElementById('memberId').value || undefined;
  const name = document.getElementById('memberName').value.trim();
  const regNo = document.getElementById('memberReg').value.trim().toLowerCase();

  if (!name || !isValidRegNo(regNo)) {
    notify('Provide a valid member name and registration number.', 'error');
    return;
  }

  if (!id) {
    notify('Select an existing member from the list before updating their profile.', 'error');
    return;
  }

  setButtonLoading(submitBtn, true);
  try {
    const payload = { name, reg_no: regNo, role: 'member' };
    const query = supabaseClient.from('users').update(payload).eq('id', id);
    await safeRequest(query, 'Saving member failed');

    e.target.reset();
    document.getElementById('memberId').value = '';
    await loadMembers(true);
    notify('Member saved.', 'success');
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

async function loadMembers(clearForm = false) {
  const { data, error } = await supabaseClient.from('users').select('*').eq('role', 'member').order('created_at', { ascending: false });
  if (error) {
    notify(error.message, 'error');
    return;
  }

  const list = document.getElementById('memberList');
  const manual = document.getElementById('manualMember');
  list.innerHTML = '';
  manual.innerHTML = '';

  (data || []).forEach((member) => {
    const item = document.createElement('div');
    item.className = 'list-item compact';
    item.innerHTML = `
      <div>
        <strong>${sanitizeText(member.name)}</strong><br />
        <small class="muted">${sanitizeText(member.reg_no)}</small>
      </div>
      <button class="btn btn-secondary" data-edit-member="${member.id}">Edit</button>`;
    list.appendChild(item);
    manual.innerHTML += `<option value="${member.id}">${sanitizeText(member.name)} (${sanitizeText(member.reg_no)})</option>`;
  });

  if (!data?.length) list.innerHTML = '<p class="muted">No members found.</p>';
  if (clearForm) document.getElementById('memberForm')?.reset();

  list.querySelectorAll('[data-edit-member]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const m = data.find((x) => x.id === btn.dataset.editMember);
      if (!m) return;
      document.getElementById('memberId').value = m.id;
      document.getElementById('memberName').value = m.name;
      document.getElementById('memberReg').value = m.reg_no;
    })
  );
}

async function savePost(e) {
  e.preventDefault();
  const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
  const id = document.getElementById('postId').value || undefined;
  const title = document.getElementById('postTitle').value.trim();
  const type = document.getElementById('postType').value;
  const eventId = document.getElementById('postEvent').value || null;
  const content = document.getElementById('postContent').value.trim();

  if (!title || !['normal', 'discussion'].includes(type) || !content || content.length > APP_CONFIG.maxTextLength) {
    notify('Please provide valid post details.', 'error');
    return;
  }

  setButtonLoading(submitBtn, true);
  try {
    const payload = { title, type, event_id: eventId, content, author_id: state.currentUser.id };
    const query = id
      ? supabaseClient.from('posts').update(payload).eq('id', id)
      : supabaseClient.from('posts').insert(payload).select().single();

    const { data } = await safeRequest(query, 'Saving post failed');

    if (!id && type === 'discussion' && data?.id) {
      await safeRequest(supabaseClient.from('topic_chats').insert({ post_id: data.id }), 'Creating discussion room failed');
    }

    e.target.reset();
    document.getElementById('postId').value = '';
    await loadPosts();
    notify('Post saved.', 'success');
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

async function loadPosts() {
  const { data, error } = await supabaseClient
    .from('posts')
    .select('*, events(topic), users(name)')
    .order('created_at', { ascending: false });
  if (error) {
    notify(error.message, 'error');
    return;
  }

  const list = document.getElementById('postList');
  list.innerHTML = '';

  (data || []).forEach((post) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div>
        <span class="badge info">${sanitizeText(post.type)}</span>
        <strong>${sanitizeText(post.title)}</strong>
        <p>${sanitizeText(post.content)}</p>
        <small class="muted">by ${sanitizeText(post.users?.name || 'Admin')} · ${formatDate(post.created_at)}</small>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary" data-edit-post="${post.id}">Edit</button>
        <button class="btn btn-danger" data-delete-post="${post.id}">Delete</button>
      </div>`;
    list.appendChild(item);
  });

  if (!data?.length) list.innerHTML = '<p class="muted">No posts available yet.</p>';

  list.querySelectorAll('[data-delete-post]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await supabaseClient.from('posts').delete().eq('id', btn.dataset.deletePost);
      await loadPosts();
      notify('Post deleted.', 'success');
    })
  );

  list.querySelectorAll('[data-edit-post]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const post = data.find((x) => x.id === btn.dataset.editPost);
      if (!post) return;
      document.getElementById('postId').value = post.id;
      document.getElementById('postTitle').value = post.title;
      document.getElementById('postType').value = post.type;
      document.getElementById('postEvent').value = post.event_id || '';
      document.getElementById('postContent').value = post.content;
    })
  );
}

async function manualAttendance(e) {
  e.preventDefault();
  const eventId = document.getElementById('manualEvent').value;
  const userId = document.getElementById('manualMember').value;

  if (!eventId || !userId) {
    notify('Select both event and member for manual attendance.', 'error');
    return;
  }

  try {
    await safeRequest(supabaseClient.from('attendance').upsert({ event_id: eventId, user_id: userId }), 'Manual attendance failed');
    notify('Manual attendance marked.', 'success');
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function downloadAttendanceCSV() {
  try {
    const { data } = await safeRequest(
      supabaseClient.from('attendance').select('timestamp, users(name,reg_no), events(topic,date_time)').order('timestamp', { ascending: false }),
      'Export failed'
    );

    const rows = ['Timestamp,Member,Reg No,Event,Event Date'];
    (data || []).forEach((r) => {
      rows.push(
        [
          new Date(r.timestamp).toISOString(),
          r.users?.name || '',
          r.users?.reg_no || '',
          r.events?.topic || '',
          r.events?.date_time ? new Date(r.events.date_time).toISOString() : ''
        ]
          .map((v) => `"${String(v).replaceAll('"', '""')}"`)
          .join(',')
      );
    });

    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `attendance-report-${Date.now()}.csv`;
    a.click();
    notify('CSV downloaded.', 'success');
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function generatePrintableReport() {
  try {
    const { members, attendance, totalEvents } = await getAttendanceReportData();
    const reportBox = document.getElementById('reportOutput');
    reportBox.innerHTML = '';

    const rows = (members || []).map((m) => {
      const count = attendance.filter((a) => a.user_id === m.id).length;
      const pct = Math.round((count / totalEvents) * 100);
      reportBox.innerHTML += `<div class="list-item compact"><span>${sanitizeText(m.name)} (${sanitizeText(m.reg_no)})</span><strong>${pct}%</strong></div>`;
      return { ...m, attendanceCount: count, attendancePct: pct };
    });

    downloadPdfDocument({
      filename: `attendance-report-${Date.now()}.pdf`,
      title: 'Debate Club Attendance Report',
      lines: [
        `Generated: ${new Date().toLocaleString()}`,
        `Total events counted: ${totalEvents}`,
        '',
        ...rows.map((row) => `${row.name} (${row.reg_no}) — ${row.attendanceCount}/${totalEvents} events (${row.attendancePct}%)`)
      ]
    });

    notify('PDF report downloaded.', 'success');
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function generateCertificates() {
  try {
    const threshold = Number(document.getElementById('certificateThreshold').value || 75);
    const { members, attendance, totalEvents } = await getAttendanceReportData();
    const reportBox = document.getElementById('reportOutput');
    reportBox.innerHTML = '<h4>Certificate Eligible Members</h4>';
    const eligible = [];

    (members || []).forEach((m) => {
      const pct = Math.round((attendance.filter((a) => a.user_id === m.id).length / totalEvents) * 100);
      if (pct >= threshold) {
        reportBox.innerHTML += `<div class="list-item compact"><strong>${sanitizeText(m.name)}</strong><span class="badge success">${pct}%</span></div>`;
        eligible.push({ ...m, attendancePct: pct });
      }
    });

    if (!eligible.length) {
      reportBox.innerHTML += '<p class="muted">No members currently meet the certificate threshold.</p>';
      notify('No members meet the certificate threshold.', 'info');
      return;
    }

    const lines = eligible.flatMap((member, index) => [
      `Certificate ${index + 1}`,
      `${member.name} (${member.reg_no})`,
      `Attendance: ${member.attendancePct}%`,
      'Recognized for consistent participation in Debate Club activities.',
      ''
    ]);

    downloadPdfDocument({
      filename: `attendance-certificates-${Date.now()}.pdf`,
      title: 'Debate Club Attendance Certificates',
      lines
    });
    notify('Certificates PDF downloaded.', 'success');
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function getAttendanceReportData() {
  const { data: members } = await safeRequest(
    supabaseClient.from('users').select('id,name,reg_no').eq('role', 'member'),
    'Could not load members'
  );
  const { data: attendance } = await safeRequest(supabaseClient.from('attendance').select('user_id,event_id'), 'Could not load attendance');
  const { data: events } = await safeRequest(supabaseClient.from('events').select('id'), 'Could not load events');

  return {
    members: members || [],
    attendance: attendance || [],
    totalEvents: Math.max(events?.length || 0, 1)
  };
}

function downloadPdfDocument({ filename, title, lines }) {
  const jsPdfApi = window.jspdf?.jsPDF;
  if (!jsPdfApi) {
    throw new Error('jsPDF failed to load. Refresh the page and try again.');
  }

  const doc = new jsPdfApi();
  const pageHeight = doc.internal.pageSize.getHeight();
  const wrappedLines = [];

  lines.forEach((line) => {
    const chunks = doc.splitTextToSize(String(line), 180);
    if (!chunks.length) wrappedLines.push('');
    else wrappedLines.push(...chunks);
  });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(title, 15, 20);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);

  let y = 30;
  wrappedLines.forEach((line) => {
    if (y > pageHeight - 15) {
      doc.addPage();
      y = 20;
    }
    doc.text(line || ' ', 15, y);
    y += 7;
  });

  doc.save(filename);
}

/* ---------------- Discussion chat ---------------- */
async function initDiscussionPage() {
  const postId = new URL(window.location.href).searchParams.get('post');
  if (!postId) {
    notify('Missing discussion topic.', 'error');
    return;
  }

  const profile = state.currentUser ? await loadProfile() : null;
  if (!profile) {
    window.location.href = 'index.html';
    return;
  }

  try {
    const { data: post } = await safeRequest(supabaseClient.from('posts').select('*').eq('id', postId).single(), 'Could not load post');
    const { data: chat } = await safeRequest(
      supabaseClient.from('topic_chats').select('*').eq('post_id', postId).single(),
      'Could not load chat room'
    );

    document.getElementById('discussionTitle').textContent = post.title;
    document.getElementById('discussionMeta').textContent = `Posted on ${formatDate(post.created_at)}`;
    document.getElementById('discussionDescription').textContent = post.content;

    await renderMessages(chat.id);
    bindRealtime(chat.id);

    document.getElementById('chatForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('chatInput');
      const content = input.value.trim();

      if (!content || content.length > APP_CONFIG.maxTextLength) {
        notify(`Message must be 1-${APP_CONFIG.maxTextLength} characters.`, 'error');
        return;
      }

      const { error } = await supabaseClient.from('messages').insert({ chat_id: chat.id, user_id: state.currentUser.id, content });
      if (error) {
        notify(error.message, 'error');
        return;
      }

      input.value = '';
    });
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function renderMessages(chatId) {
  const { data, error } = await supabaseClient
    .from('messages')
    .select('*, users(name)')
    .eq('chat_id', chatId)
    .order('timestamp', { ascending: true })
    .limit(200);

  if (error) {
    notify(error.message, 'error');
    return;
  }

  const box = document.getElementById('chatMessages');
  box.innerHTML = '';

  (data || []).forEach((msg) => {
    const own = msg.user_id === state.currentUser.id;
    const div = document.createElement('div');
    div.className = `msg ${own ? 'self' : ''}`;
    div.innerHTML = `
      <div>${sanitizeText(msg.content)}</div>
      <div class="meta">${sanitizeText(msg.users?.name || 'User')} · ${formatDate(msg.timestamp)}</div>
      ${state.currentProfile?.role === 'admin' ? `<button class="btn btn-danger" data-delete-msg="${msg.id}">Delete</button>` : ''}`;
    box.appendChild(div);
  });

  if (!data?.length) {
    box.innerHTML = '<p class="muted">No messages yet. Start the discussion.</p>';
  }

  box.scrollTop = box.scrollHeight;

  box.querySelectorAll('[data-delete-msg]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const { error: deleteError } = await supabaseClient.from('messages').delete().eq('id', btn.dataset.deleteMsg);
      if (deleteError) return notify(deleteError.message, 'error');
      await renderMessages(chatId);
    })
  );
}

function bindRealtime(chatId) {
  if (state.realtimeChannel) {
    supabaseClient.removeChannel(state.realtimeChannel);
  }

  state.realtimeChannel = supabaseClient
    .channel(`chat-${chatId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` }, async () => {
      await renderMessages(chatId);
    })
    .subscribe();
}

bootstrap();
