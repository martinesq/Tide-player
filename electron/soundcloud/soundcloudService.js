/*
 * SoundCloud client for Orchard.
 *
 * Talks to SoundCloud's api-v2 (the same API soundcloud.com uses), signs in
 * through a persistent BrowserWindow session, and exposes results normalized
 * to the same item/section shapes the YouTube Music catalog produces so the
 * renderer can list and play them without knowing where they came from.
 *
 * Ids are namespaced: tracks are `sc:<id>`, playlists `sc:playlist:<id>`,
 * users (shown as artists) `sc:user:<id>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const API = 'https://api-v2.soundcloud.com';
const WEB = 'https://soundcloud.com';
const PARTITION = 'persist:orchard-soundcloud';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MODES = ['ytm', 'sc', 'both'];
const MEDIA_TTL_MS = 4 * 60 * 1000;

export const SC_TRACK_PREFIX = 'sc:';
export const isSoundCloudId = (value) => typeof value === 'string' && value.startsWith(SC_TRACK_PREFIX);

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function compactCount(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function artwork(...candidates) {
  const url = candidates.find(Boolean) || '';
  return url.replace(/-(large|t\d+x\d+|crop|badge|small|tiny|mini)\./, '-t500x500.');
}

export function createSoundCloudService({ app, BrowserWindow, session, fetchImpl = globalThis.fetch, getMainWindow }) {
  const settingsPath = path.join(app.getPath('userData'), 'soundcloud-settings.json');
  const authSession = () => session.fromPartition(PARTITION);
  const mediaCache = new Map();
  let settings = loadSettings();
  let clientId = settings.clientId || '';
  let clientIdPromise = null;
  let token = '';
  let me = null;
  let loginWindow = null;
  let loginPromise = null;

  function loadSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return { mode: MODES.includes(parsed.mode) ? parsed.mode : 'ytm', clientId: parsed.clientId || '' };
    } catch {
      return { mode: 'ytm', clientId: '' };
    }
  }

  function saveSettings() {
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
    } catch (error) {
      console.warn(`Could not save SoundCloud settings: ${error.message}`);
    }
  }

  function getMode() {
    return settings.mode;
  }

  function setMode(mode) {
    if (!MODES.includes(mode)) throw new Error(`Unknown source mode: ${mode}`);
    settings = { ...settings, mode };
    saveSettings();
    return mode;
  }

  /* ---------------------------------------------------------------- auth */

  async function readToken() {
    try {
      const cookies = await authSession().cookies.get({ name: 'oauth_token' });
      const cookie = cookies.find((c) => /soundcloud\.com$/i.test(c.domain || ''));
      token = cookie ? decodeURIComponent(cookie.value) : '';
    } catch {
      token = '';
    }
    return token;
  }

  async function refreshAccount() {
    await readToken();
    if (!token) {
      me = null;
      return null;
    }
    try {
      me = await api('/me');
    } catch (error) {
      // An expired/invalid token must not leave the UI thinking we're signed in.
      if (/\b40[13]\b/.test(error.message)) {
        token = '';
        me = null;
      }
    }
    return me;
  }

  function accountSummary() {
    if (!me) return { name: 'SoundCloud', byline: 'SoundCloud', thumbnail: null };
    return {
      name: me.username || me.full_name || 'SoundCloud',
      byline: 'SoundCloud',
      thumbnail: artwork(me.avatar_url) || null
    };
  }

  async function status() {
    await refreshAccount();
    return {
      mode: settings.mode,
      signedIn: Boolean(token && me),
      user: token && me ? accountSummary() : null
    };
  }

  function login() {
    if (loginPromise) {
      loginWindow?.focus();
      return loginPromise;
    }

    loginPromise = new Promise((resolve) => {
      const parent = getMainWindow?.();
      loginWindow = new BrowserWindow({
        width: 520,
        height: 760,
        title: 'Sign in to SoundCloud',
        autoHideMenuBar: true,
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        webPreferences: {
          partition: PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      // Social sign-in providers reject UAs that identify as Electron.
      loginWindow.webContents.setUserAgent(USER_AGENT);
      loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));

      let finished = false;
      const finish = async () => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        const result = await status().catch(() => ({ mode: settings.mode, signedIn: false, user: null }));
        if (loginWindow && !loginWindow.isDestroyed()) loginWindow.destroy();
        loginWindow = null;
        loginPromise = null;
        resolve(result);
      };

      const poll = setInterval(async () => {
        if (await readToken()) await finish();
      }, 1500);
      loginWindow.on('closed', () => {
        loginWindow = null;
        void finish();
      });
      loginWindow.loadURL(`${WEB}/signin`).catch(() => {});
    });

    return loginPromise;
  }

  async function logout() {
    const ses = authSession();
    await ses.clearStorageData().catch(() => {});
    await ses.clearCache().catch(() => {});
    token = '';
    me = null;
    mediaCache.clear();
    return status();
  }

  /* ------------------------------------------------------------ transport */

  async function discoverClientId() {
    const home = await (await fetchImpl(WEB, { headers: { 'User-Agent': USER_AGENT } })).text();
    const scripts = [...home.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
      .map((match) => match[1])
      .reverse();

    for (const src of scripts) {
      try {
        const body = await (await fetchImpl(src, { headers: { 'User-Agent': USER_AGENT } })).text();
        const found = body.match(/[?&,{]client_id[:=]"?([A-Za-z0-9]{32})"?/);
        if (found) return found[1];
      } catch {
        // try the next bundle
      }
    }
    throw new Error('Could not find a SoundCloud client id');
  }

  async function ensureClientId(force = false) {
    if (clientId && !force) return clientId;
    clientIdPromise ||= discoverClientId()
      .then((id) => {
        clientId = id;
        settings = { ...settings, clientId: id };
        saveSettings();
        return id;
      })
      .finally(() => { clientIdPromise = null; });
    return clientIdPromise;
  }

  function headers({ auth = true } = {}) {
    return {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': USER_AGENT,
      Origin: WEB,
      Referer: `${WEB}/`,
      ...(auth && token ? { Authorization: `OAuth ${token}` } : {})
    };
  }

  async function api(pathname, params = {}, { retried = false, auth = true, method = 'GET', body } = {}) {
    const id = await ensureClientId();
    const url = new URL(pathname.startsWith('http') ? pathname : `${API}${pathname}`);
    for (const [key, value] of Object.entries({ ...params, client_id: id })) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }

    const init = { method, headers: headers({ auth }) };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    // Writes go through the SoundCloud partition's Chromium session, which carries the
    // same cookies and network stack as soundcloud.com; reads keep the plain fetch.
    const sessionFetch = method !== 'GET' && typeof authSession().fetch === 'function'
      ? (target, options) => authSession().fetch(target, options)
      : fetchImpl;
    const response = await sessionFetch(url, init);
    if ((response.status === 401 || response.status === 403) && !retried) {
      await ensureClientId(true);
      return api(pathname, params, { retried: true, auth, method, body });
    }
    if (!response.ok) throw new Error(`SoundCloud request failed (${response.status}) ${method} ${pathname}`);
    if (method === 'GET') return response.json();
    const text = await response.text().catch(() => '');
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }

  /**
   * Renews the access token from the `oauth_refresh_token` cookie, as soundcloud.com does
   * when its token expires. Resolves to true when a fresh `oauth_token` is in place.
   */
  async function refreshSession() {
    const ses = authSession();
    if (typeof ses.fetch !== 'function') return false;
    for (const target of [`${WEB}/-/refresh-token`, `${API}/-/refresh-token`]) {
      try {
        const response = await ses.fetch(target, { method: 'POST', headers: { 'User-Agent': USER_AGENT } });
        if (response.ok) {
          const before = token;
          await readToken();
          if (token && token !== before) return true;
        }
      } catch {
        // try the next refresh host
      }
    }
    return false;
  }

  /**
   * Tries each `[method, path, body]` in turn until one is accepted. A 401/403 gets one
   * token refresh and a retry of the same route before falling through to the next one.
   */
  async function writeWithFallback(label, attempts) {
    const failures = [];
    for (const [method, pathname, body] of attempts) {
      try {
        return await api(pathname, {}, { method, body });
      } catch (error) {
        if (/\((401|403)\)/.test(error.message) && await refreshSession()) {
          try {
            return await api(pathname, {}, { method, body });
          } catch (retryError) {
            error = retryError;
          }
        }
        console.warn(`SoundCloud ${label} via ${method} ${pathname} failed: ${error.message}`);
        failures.push(error.message);
      }
    }
    throw new Error(`SoundCloud ${label} failed: ${failures.join('; ')}`);
  }

  /** Follows `next_href` until the collection is exhausted (or `max` entries were read). */
  async function apiAll(pathname, params = {}, { max = 10000, auth = true } = {}) {
    const collection = [];
    let next = null;
    for (let page = 0; page < 200 && collection.length < max; page += 1) {
      const data = await (next ? api(next, {}, { auth }) : api(pathname, { limit: 200, ...params }, { auth }));
      collection.push(...(data?.collection || []));
      next = data?.next_href || null;
      if (!next) break;
    }
    return collection;
  }

  /* ---------------------------------------------------------- normalizers */

  function normalizeTrack(track) {
    if (!track?.id || !track.title) return null;
    const user = track.user || {};
    const seconds = Math.round((track.full_duration || track.duration || 0) / 1000);
    return {
      id: `${SC_TRACK_PREFIX}${track.id}`,
      browseId: null,
      browsePayload: null,
      type: 'song',
      musicVideoType: '',
      isAudioOnly: true,
      title: track.title,
      subtitle: [user.username, track.playback_count ? `${compactCount(track.playback_count)} plays` : ''].filter(Boolean).join(' • '),
      artists: [user.username].filter(Boolean),
      artistBrowseIds: user.id ? [`${SC_TRACK_PREFIX}user:${user.id}`] : [],
      album: '',
      albumId: null,
      duration: formatDuration(seconds),
      durationSeconds: seconds,
      explicit: false,
      year: String(track.created_at || '').slice(0, 4),
      views: track.playback_count ? compactCount(track.playback_count) : '',
      viewCount: Number(track.playback_count || 0),
      itemCount: '',
      thumbnail: artwork(track.artwork_url, user.avatar_url),
      isUpload: false,
      source: 'soundcloud',
      permalinkUrl: track.permalink_url || ''
    };
  }

  function normalizePlaylist(playlist) {
    if (!playlist?.id) return null;
    const browseId = `${SC_TRACK_PREFIX}playlist:${playlist.id}`;
    const user = playlist.user || {};
    const count = playlist.track_count || playlist.tracks?.length || 0;
    return {
      id: null,
      browseId,
      browsePayload: { browseId },
      type: 'playlist',
      musicVideoType: '',
      isAudioOnly: false,
      title: playlist.title || 'Untitled',
      subtitle: [user.username, count ? `${count} tracks` : ''].filter(Boolean).join(' • '),
      artists: [user.username].filter(Boolean),
      artistBrowseIds: user.id ? [`${SC_TRACK_PREFIX}user:${user.id}`] : [],
      album: '',
      albumId: null,
      duration: '',
      durationSeconds: 0,
      explicit: false,
      year: String(playlist.created_at || '').slice(0, 4),
      views: '',
      itemCount: count ? `${count} tracks` : '',
      releaseType: '',
      thumbnail: artwork(playlist.artwork_url, playlist.tracks?.find((t) => t.artwork_url)?.artwork_url, user.avatar_url),
      index: '',
      source: 'soundcloud'
    };
  }

  function normalizeUser(user) {
    if (!user?.id) return null;
    const browseId = `${SC_TRACK_PREFIX}user:${user.id}`;
    return {
      id: null,
      browseId,
      browsePayload: { browseId },
      type: 'artist',
      musicVideoType: '',
      isAudioOnly: false,
      title: user.username || user.full_name || 'Unknown',
      subtitle: user.followers_count ? `${compactCount(user.followers_count)} followers` : 'SoundCloud',
      artists: [],
      artistBrowseIds: [],
      album: '',
      albumId: null,
      duration: '',
      durationSeconds: 0,
      explicit: false,
      year: '',
      views: '',
      itemCount: user.track_count ? `${user.track_count} tracks` : '',
      thumbnail: artwork(user.avatar_url),
      index: '',
      source: 'soundcloud'
    };
  }

  const tracksOf = (collection = []) => collection.map(normalizeTrack).filter(Boolean);

  /* --------------------------------------------------------------- search */

  async function search(query, filter = 'all') {
    const q = String(query || '').trim();
    if (!q) return { filters: [], didYouMean: '', showingResultsFor: '', message: '', sections: [] };

    const all = filter === 'all';
    const [tracks, playlists, users] = await Promise.all([
      all || filter === 'songs' ? api('/search/tracks', { q, limit: all ? 15 : 30 }).catch(() => null) : null,
      all || filter === 'playlists' ? api('/search/playlists_without_albums', { q, limit: all ? 8 : 30 }).catch(() => null) : null,
      all || filter === 'artists' ? api('/search/users', { q, limit: all ? 6 : 30 }).catch(() => null) : null
    ]);

    const sections = [
      { key: 'songs', title: 'Songs', items: tracksOf(tracks?.collection) },
      { key: 'artists', title: 'Artists', items: (users?.collection || []).map(normalizeUser).filter(Boolean) },
      { key: 'playlists', title: 'Playlists', items: (playlists?.collection || []).map(normalizePlaylist).filter(Boolean) }
    ].filter((section) => section.items.length > 0);

    return { filters: [], didYouMean: '', showingResultsFor: '', message: '', sections };
  }

  async function suggestions(query) {
    const result = await api('/search/queries', { q: query, limit: 8 }).catch(() => ({ collection: [] }));
    return (result.collection || [])
      .map((entry) => entry.output || entry.query)
      .filter(Boolean)
      .map((text) => ({ type: 'suggestion', text, title: text, query: text }));
  }

  /* ----------------------------------------------------------- collections */

  async function hydrateTracks(stubs = []) {
    const full = stubs.filter((track) => track?.title);
    const missing = stubs.filter((track) => track && !track.title).map((track) => track.id);
    const byId = new Map(full.map((track) => [track.id, track]));

    for (let i = 0; i < missing.length; i += 30) {
      const chunk = missing.slice(i, i + 30);
      try {
        const loaded = await api('/tracks', { ids: chunk.join(',') });
        for (const track of loaded) byId.set(track.id, track);
      } catch {
        // leave the stubs out; the remaining tracks still play
      }
    }

    return stubs.map((stub) => byId.get(stub?.id)).filter(Boolean);
  }

  async function playlist(browseId) {
    const id = String(browseId).split(':').pop();
    const data = await api(`/playlists/${id}`, { representation: 'full' });
    const tracks = tracksOf(await hydrateTracks(data.tracks || [])).map((track, index) => ({ ...track, index: String(index + 1) }));
    const normalized = normalizePlaylist(data);
    return {
      kind: data.is_album ? 'album' : 'playlist',
      browseId,
      title: data.title || 'Playlist',
      subtitle: data.user?.username || '',
      artist: data.user?.username || '',
      artistBrowseId: data.user?.id ? `${SC_TRACK_PREFIX}user:${data.user.id}` : '',
      year: String(data.created_at || '').slice(0, 4),
      itemCount: `${tracks.length} tracks`,
      totalTrackCount: tracks.length,
      totalDuration: formatDuration((data.duration || 0) / 1000),
      views: '',
      description: data.description || '',
      thumbnail: normalized?.thumbnail || '',
      tracks,
      continuation: '',
      hasMoreTracks: false,
      sections: []
    };
  }

  async function artist(browseId) {
    const id = String(browseId).split(':').pop();
    const [user, tracks, playlists] = await Promise.all([
      api(`/users/${id}`),
      api(`/users/${id}/toptracks`, { limit: 20 }).catch(() => api(`/users/${id}/tracks`, { limit: 20 })).catch(() => ({ collection: [] })),
      api(`/users/${id}/playlists_without_albums`, { limit: 20 }).catch(() => ({ collection: [] }))
    ]);
    const popular = tracksOf(tracks.collection).map((track, index) => ({ ...track, index: String(index + 1) }));
    const sections = [];
    if (popular.length > 5) sections.push({ key: 'sc-tracks', title: 'Tracks', items: popular.slice(5), browsePayload: null });
    const lists = (playlists.collection || []).map(normalizePlaylist).filter(Boolean);
    if (lists.length) sections.push({ key: 'sc-playlists', title: 'Playlists', items: lists, browsePayload: null });

    return {
      kind: 'artist',
      browseId,
      title: user.username || 'Artist',
      subtitle: user.followers_count ? `${compactCount(user.followers_count)} followers` : 'SoundCloud',
      artist: user.username || '',
      year: '',
      itemCount: user.track_count ? `${user.track_count} tracks` : '',
      totalDuration: '',
      views: '',
      description: user.description || '',
      thumbnail: artwork(user.avatar_url),
      tracks: popular.slice(0, 5),
      sections
    };
  }

  async function related(trackId) {
    const id = String(trackId).replace(SC_TRACK_PREFIX, '');
    const result = await api(`/tracks/${id}/related`, { limit: 25 });
    return tracksOf(result.collection);
  }

  /* ------------------------------------------------------------------ feed */

  function feedEntryItem(entry) {
    if (entry?.track) return normalizeTrack(entry.track);
    if (entry?.playlist) return normalizePlaylist(entry.playlist);
    return null;
  }

  async function feed() {
    await refreshAccount();
    const signedIn = Boolean(token && me);
    const sections = [];
    const library = [];

    const soft = (label, promise) => promise.catch((error) => {
      console.warn(`SoundCloud ${label} failed: ${error.message}`);
      return null;
    });
    const [stream, charts, likes, playlists, likedPlaylists, following] = await Promise.all([
      signedIn ? soft('stream', api('/stream', { limit: 40 })) : null,
      soft('charts', api('/charts', { kind: 'trending', genre: 'soundcloud:genres:all-music', limit: 30 })),
      signedIn ? soft('likes', api(`/users/${me.id}/track_likes`, { limit: 200 })) : null,
      signedIn ? soft('playlists', apiAll(`/users/${me.id}/playlists_without_albums`, {}).then((collection) => ({ collection }))) : null,
      signedIn ? soft('playlist likes', apiAll(`/users/${me.id}/playlist_likes`, {}).then((collection) => ({ collection }))) : null,
      signedIn ? soft('followings', apiAll(`/users/${me.id}/followings`, {}).then((collection) => ({ collection }))) : null
    ]);

    const push = (target, key, title, items) => {
      const clean = (items || []).filter(Boolean);
      if (clean.length) target.push({ key, title, items: clean, browsePayload: null });
    };

    push(sections, 'sc-feed', 'SoundCloud · Your feed', (stream?.collection || []).map(feedEntryItem));
    push(sections, 'sc-charts', 'SoundCloud · Trending', (charts?.collection || []).map((entry) => normalizeTrack(entry.track)));
    push(library, 'sc-likes', 'SoundCloud · Liked tracks', (likes?.collection || []).map((entry) => normalizeTrack(entry.track)).filter(Boolean).map((track) => ({ ...track, fromLikes: true })));
    push(library, 'sc-playlists', 'SoundCloud · Your playlists', (playlists?.collection || []).map(normalizePlaylist));
    push(library, 'sc-liked-playlists', 'SoundCloud · Liked playlists', (likedPlaylists?.collection || []).map((entry) => normalizePlaylist(entry.playlist)));
    push(library, 'sc-following', 'SoundCloud · Following', (following?.collection || []).map(normalizeUser));

    return { home: { filters: [], sections }, library: { filters: [], sections: library }, signedIn };
  }

  async function libraryCategory(title) {
    await refreshAccount();
    if (!token || !me) return [];
    const key = String(title || '').trim().toLowerCase();
    const soft = (promise) => promise.catch((error) => {
      console.warn(`SoundCloud ${key} failed: ${error.message}`);
      return [];
    });
    const ownPlaylists = () => soft(apiAll(`/users/${me.id}/playlists_without_albums`));
    const ownAlbums = () => soft(apiAll(`/users/${me.id}/albums`));
    const likedPlaylists = () => soft(apiAll(`/users/${me.id}/playlist_likes`));
    const likedAlbums = () => soft(apiAll(`/users/${me.id}/albums_likes`));
    const uniq = (items) => {
      const seen = new Set();
      return items.filter((item) => {
        const id = item?.id || item?.browseId;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    };

    if (key === 'songs' || key === 'likes') {
      const likes = await apiAll(`/users/${me.id}/track_likes`);
      const tracks = uniq(likes.map((entry) => normalizeTrack(entry.track)).filter(Boolean));
      return key === 'likes' ? tracks.map((track) => ({ ...track, fromLikes: true })) : tracks;
    }
    if (key === 'playlists') {
      const [own, liked] = await Promise.all([ownPlaylists(), likedPlaylists()]);
      return uniq([
        ...own.map(normalizePlaylist),
        ...liked.filter((entry) => !entry.playlist?.is_album).map((entry) => normalizePlaylist(entry.playlist))
      ].filter(Boolean));
    }
    if (key === 'albums') {
      const [own, liked, likedAlb] = await Promise.all([ownAlbums(), likedPlaylists(), likedAlbums()]);
      return uniq([
        ...own.map(normalizePlaylist),
        ...liked.filter((entry) => entry.playlist?.is_album).map((entry) => normalizePlaylist(entry.playlist)),
        ...likedAlb.map((entry) => normalizePlaylist(entry.playlist || entry))
      ].filter(Boolean));
    }
    if (key === 'artists' || key === 'following') {
      const following = await apiAll(`/users/${me.id}/followings`);
      return uniq(following.map(normalizeUser).filter(Boolean)).map((user) => ({ ...user, name: user.title }));
    }
    if (key === 'stations') {
      const library = await soft(apiAll('/me/library/all', {}, { max: 2000 }));
      return uniq(library.map((entry) => entry.system_playlist && normalizePlaylist(entry.system_playlist)).filter(Boolean));
    }
    if (key === 'history') {
      const history = await soft(apiAll('/me/play-history/tracks', {}, { max: 1000 }));
      return uniq(history.map((entry) => normalizeTrack(entry.track)).filter(Boolean));
    }
    return [];
  }

  /*
   * soundcloud.com's own actions (like, add/create playlist) are Next.js server actions. Their ids
   * and the build (deployment) id are not constants: they come from the current web build, so they
   * are discovered from a track page and its chunks, and rediscovered when an action answers 404.
   */
  const WEB_ACTIONS = ['likeTrackAction', 'addToPlaylistAction', 'createPlaylist'];
  let webBuild = { deployment: '', actions: {} };

  async function discoverWebBuild(pagePath) {
    const html = await (await fetchImpl(pagePath, { headers: { 'User-Agent': USER_AGENT } })).text();
    const deployment = html.match(/[?&]dpl=([0-9a-f]{40})/)?.[1] || '';
    const chunks = [...new Set([...html.matchAll(/https:\/\/[^"'\s]+\/_next\/static\/chunks\/[^"'\s]+?\.js[^"'\s]*/g)]
      .map((match) => match[0].replace(/&amp;/g, '&')))];
    const actions = {};
    for (let i = 0; i < chunks.length && Object.keys(actions).length < WEB_ACTIONS.length; i += 8) {
      const bodies = await Promise.all(chunks.slice(i, i + 8).map((url) =>
        fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } }).then((r) => r.text()).catch(() => '')));
      for (const body of bodies) {
        for (const name of WEB_ACTIONS) {
          if (actions[name]) continue;
          const found = body.match(new RegExp(`createServerReference\\)?\\("([0-9a-f]{42})"[^;]*?"${name}"\\)`));
          if (found) actions[name] = found[1];
        }
      }
    }
    if (!actions.likeTrackAction) throw new Error('Could not find the SoundCloud web actions in the current build');
    console.log(`SoundCloud web build ${deployment || 'unknown'}: ${Object.entries(actions).map(([n, v]) => `${n} ${v}`).join(', ')}`);
    return { deployment, actions };
  }

  /** Calls one web action with the session cookies, the way the site does. Returns the response text. */
  async function webAction(name, pagePath, args, { retry = true } = {}) {
    if (!webBuild.actions[name]) webBuild = await discoverWebBuild(pagePath);
    const ses = authSession();
    const datadome = (await ses.cookies.get({ name: 'datadome' }).catch(() => []))[0]?.value || '';
    const response = await ses.fetch(pagePath, {
      method: 'POST',
      headers: {
        Accept: 'text/x-component',
        'Content-Type': 'text/plain;charset=UTF-8',
        'next-action': webBuild.actions[name],
        ...(webBuild.deployment ? { 'x-deployment-id': webBuild.deployment } : {}),
        Origin: WEB,
        Referer: `${WEB}/`,
        'User-Agent': USER_AGENT,
        ...(datadome ? { 'x-datadome-clientid': datadome } : {})
      },
      body: JSON.stringify(args)
    });
    const text = await response.text().catch(() => '');
    if (response.status === 404 && retry) {
      // The build changed under us: forget the cached actions and discover them again, once.
      webBuild = { deployment: '', actions: {} };
      return webAction(name, pagePath, args, { retry: false });
    }
    if (!response.ok || /"error"|unauthori[sz]ed|forbidden/i.test(text)) {
      throw new Error(`SoundCloud ${name} returned ${response.status} (build ${webBuild.deployment || 'unknown'})`);
    }
    return text;
  }

  async function trackPagePath(trackId) {
    const track = await api(`/tracks/${trackId}`);
    return { track, pagePath: `${WEB}/n/${track.user?.permalink}/${track.permalink}` };
  }

  /** Likes a track the way soundcloud.com does. */
  async function webLike(id) {
    const { pagePath } = await trackPagePath(id);
    return webAction('likeTrackAction', pagePath, [`soundcloud:tracks:${id}`]);
  }

  let likedIds = { at: 0, ids: new Set() };

  async function loadLikedIds() {
    if (Date.now() - likedIds.at < 60_000) return likedIds.ids;
    const ids = await api('/me/track_likes/ids', { limit: 5000 });
    likedIds = { at: Date.now(), ids: new Set((Array.isArray(ids) ? ids : ids.collection || []).map(String)) };
    return likedIds.ids;
  }

  async function likeStatus(videoId) {
    await refreshAccount();
    if (!token || !me) return { videoId, liked: false };
    const ids = await loadLikedIds();
    return { videoId, liked: ids.has(String(videoId).replace(SC_TRACK_PREFIX, '')) };
  }

  async function setLike(videoId, liked) {
    await refreshAccount();
    if (!token || !me) throw new Error('Sign in to SoundCloud to like tracks.');
    const id = String(videoId).replace(SC_TRACK_PREFIX, '');
    const urn = `soundcloud:tracks:${id}`;
    if (liked) {
      // The web's own like is a Next.js server action, which api-v2 does not accept from here
      // (DataDome answers 403/404). api-v2 is kept as the fallback.
      try {
        await webLike(id);
      } catch (webError) {
        console.warn(`SoundCloud web like failed: ${webError.message}`);
        await writeWithFallback('like', [
          ['POST', `/users/${me.id}/track_likes/${id}`],
          ['PUT', `/users/${me.id}/track_likes/${id}`]
        ]).catch((error) => {
          throw new Error(`${webError.message}; ${error.message}`);
        });
      }
    } else {
      // DELETE users/<id>/track_likes/<id> is the route that works for unliking.
      await writeWithFallback('unlike', [
        ['DELETE', `/users/${me.id}/track_likes/${id}`],
        ['DELETE', `/likes/tracks/${urn}`]
      ]);
    }
    const ids = await loadLikedIds().catch(() => likedIds.ids);
    if (liked) ids.add(id);
    else ids.delete(id);
    likedIds = { at: Date.now(), ids };
    return { videoId, liked: Boolean(liked) };
  }

  /* ------------------------------------------------------------- playlists */

  const trackNumericId = (trackId) => Number(String(trackId).replace(SC_TRACK_PREFIX, ''));
  const playlistNumericId = (playlistId) => String(playlistId).split(':').pop();

  /** The signed-in user's own playlists, flagged with whether they already hold `videoId`. */
  async function editablePlaylists(videoId) {
    await refreshAccount();
    if (!token || !me) throw new Error('Sign in to SoundCloud to edit playlists.');
    const trackId = trackNumericId(videoId);
    const own = await apiAll(`/users/${me.id}/playlists_without_albums`, {}).catch(() => []);
    const playlists = own.filter((entry) => entry?.id && !entry.is_album);

    return Promise.all(playlists.map(async (playlist) => {
      const full = await api(`/playlists/${playlist.id}`).catch(() => null);
      const trackIds = (full?.tracks || []).map((track) => Number(track.id));
      return {
        id: `${SC_TRACK_PREFIX}playlist:${playlist.id}`,
        title: playlist.title || 'Untitled',
        subtitle: `${playlist.track_count ?? trackIds.length} tracks`,
        thumbnail: artwork(playlist.artwork_url, playlist.tracks?.find((t) => t.artwork_url)?.artwork_url) || '',
        editable: true,
        containsTrack: trackIds.includes(trackId),
        privacy: playlist.sharing === 'private' ? 'private' : 'public'
      };
    }));
  }

  /** Runs the web action first (the site's own route); falls back to api-v2 if the web call fails. */
  async function viaWebThenApi(webCall, apiCall, label) {
    try {
      return await webCall();
    } catch (webError) {
      console.warn(`SoundCloud ${label} via web failed: ${webError.message}`);
      return apiCall().catch((apiError) => {
        throw new Error(`${webError.message}; ${apiError.message}`);
      });
    }
  }

  async function addToPlaylist(playlistId, videoId) {
    await refreshAccount();
    if (!token || !me) throw new Error('Sign in to SoundCloud to edit playlists.');
    const pid = playlistNumericId(playlistId);
    const trackId = trackNumericId(videoId);
    const data = await api(`/playlists/${pid}`);
    if (data?.user?.id !== me.id) throw new Error('This playlist cannot be edited.');

    const current = (data.tracks || []).map((track) => Number(track.id));
    if (current.includes(trackId)) throw new Error('This song is already in that playlist.');

    const { pagePath } = await trackPagePath(trackId);
    await viaWebThenApi(
      () => webAction('addToPlaylistAction', pagePath, [{
        trackUrns: [`soundcloud:tracks:${trackId}`],
        playlistUrn: `soundcloud:playlists:${pid}`
      }]),
      () => api(`/playlists/${pid}`, {}, {
        method: 'PUT',
        body: { playlist: { tracks: [...current, trackId].map((id) => ({ id })) } }
      }),
      'add to playlist'
    );
    return { id: playlistId };
  }

  async function createPlaylist(title, videoId) {
    await refreshAccount();
    if (!token || !me) throw new Error('Sign in to SoundCloud to edit playlists.');
    const trackId = trackNumericId(videoId);
    const { pagePath } = await trackPagePath(trackId);

    const created = await viaWebThenApi(
      async () => {
        const text = await webAction('createPlaylist', pagePath, [{
          title,
          isPublic: false,
          description: '',
          urns: [`soundcloud:tracks:${trackId}`]
        }]);
        const urn = text.match(/soundcloud:playlists:(\d+)/);
        if (!urn) throw new Error('SoundCloud did not return the new playlist');
        return { id: Number(urn[1]) };
      },
      () => api('/playlists', {}, {
        method: 'POST',
        body: { playlist: { title, sharing: 'private', tracks: [{ id: trackId }] } }
      }),
      'create playlist'
    );
    if (!created?.id) throw new Error('SoundCloud did not create the playlist.');
    return { id: `${SC_TRACK_PREFIX}playlist:${created.id}`, title };
  }

  /* -------------------------------------------------------------- playback */

  async function resolveMedia(trackId) {
    const id = String(trackId).replace(SC_TRACK_PREFIX, '');
    const cached = mediaCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const data = await api(`/tracks/${id}`);
    const transcodings = data.media?.transcodings || [];
    if (!transcodings.length) throw new Error('This SoundCloud track is not available for streaming');

    const rank = (t) => {
      const progressive = t.format?.protocol === 'progressive';
      const mp3 = /mpeg/i.test(t.format?.mime_type || '');
      return (progressive ? 0 : 10) + (mp3 ? 0 : 5) + (/opus/i.test(t.format?.mime_type || '') ? 1 : 0);
    };
    let chosen = null;
    let resolved = null;
    let lastError = null;
    for (const candidate of [...transcodings].sort((a, b) => rank(a) - rank(b))) {
      try {
        const result = await api(candidate.url, { track_authorization: data.track_authorization });
        if (result?.url) {
          chosen = candidate;
          resolved = result;
          break;
        }
      } catch (error) {
        // some transcodings 404 for a given track; the next one may still stream
        lastError = error;
      }
    }
    if (!resolved) {
      if (/\(404\)/.test(lastError?.message || '')) throw new Error('This SoundCloud track is not available for streaming');
      throw lastError || new Error('SoundCloud did not return a stream URL');
    }
    // "cbc-encrypted-hls"/"ctr-encrypted-hls" are FairPlay/Widevine-style
    // SAMPLE-AES streams: every segment is ciphertext that needs a real DRM
    // license exchange to decrypt. There is no plain byte-proxy fix for that --
    // feeding the encrypted bytes to the player is exactly what produced
    // DEMUXER_ERROR_COULD_NOT_OPEN. SoundCloud only falls back to these for
    // certain tracks once progressive/plain-HLS aren't available, so fail with
    // a clear message instead of a cryptic decoder crash.
    if (/encrypted/i.test(chosen.format?.protocol || '')) {
      throw new Error('This SoundCloud track is DRM-protected and cannot be played in Tide.');
    }

    const protocol = chosen.format?.protocol === 'progressive' ? 'progressive' : 'hls';
    const rawMime = chosen.format?.mime_type || 'audio/mpeg';
    // SoundCloud's HLS AAC preset serves fragmented MP4 (CMAF) segments, not raw
    // ADTS frames, so the stitched response below is ISO-BMFF, never "audio/aac".
    // Labeling it that way made Chromium hand the bytes to FFmpeg's ADTS demuxer,
    // which can't find a sync word in MP4 box data: DEMUXER_ERROR_COULD_NOT_OPEN.
    const isHlsAac = protocol === 'hls' && /mp4a|aac/i.test(rawMime);
    const media = {
      protocol,
      url: resolved.url,
      mimeType: isHlsAac ? 'audio/mp4' : rawMime,
      track: normalizeTrack(data),
      expiresAt: Date.now() + MEDIA_TTL_MS
    };
    mediaCache.set(id, media);
    return media;
  }

  async function resolveTrack(trackId, streamBaseUrl) {
    const media = await resolveMedia(trackId);
    const track = media.track;
    return {
      id: track.id,
      title: track.title,
      artist: track.artists[0] || '',
      durationSeconds: track.durationSeconds,
      thumbnail: track.thumbnail,
      isLive: false,
      viewCount: track.viewCount || 0,
      youtubeVideoId: '',
      mediaKind: 'audio',
      mimeType: media.mimeType,
      itag: 0,
      bitrate: media.protocol === 'progressive' ? 128 : 160,
      audioItag: null,
      audioStreamUrl: '',
      playbackSource: 'soundcloud',
      authenticatedPlayback: Boolean(token),
      externalSource: 'soundcloud',
      streamUrl: `${streamBaseUrl}/${encodeURIComponent(track.id)}`,
      streamExpiresAt: 0
    };
  }

  async function proxyStream(trackId, req, res, corsHeaders = {}) {
    let media = await resolveMedia(trackId);
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    if (media.protocol === 'progressive') {
      const range = req.headers.range;
      let upstream = await fetchImpl(media.url, {
        headers: { 'User-Agent': USER_AGENT, ...(range ? { Range: range } : {}) },
        signal: controller.signal
      });
      if (upstream.status === 403 || upstream.status === 404) {
        mediaCache.delete(String(trackId).replace(SC_TRACK_PREFIX, ''));
        media = await resolveMedia(trackId);
        upstream = await fetchImpl(media.url, {
          headers: { 'User-Agent': USER_AGENT, ...(range ? { Range: range } : {}) },
          signal: controller.signal
        });
      }
      if (!upstream.ok && upstream.status !== 206) throw new Error(`SoundCloud stream returned HTTP ${upstream.status}`);

      const out = { ...corsHeaders, 'Content-Type': media.mimeType, 'Accept-Ranges': 'bytes' };
      for (const name of ['content-length', 'content-range']) {
        const value = upstream.headers.get(name);
        if (value) out[name] = value;
      }
      res.writeHead(upstream.status, out);
      Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
      return;
    }

    // HLS: stitch the segments into one continuous (non-seekable) response.
    const playlistText = await (await fetchImpl(media.url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal })).text();
    const segments = playlistText
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => new URL(line, media.url).toString());
    if (!segments.length) throw new Error('SoundCloud returned an empty HLS playlist');
    // Fragmented-MP4 playlists point at a separate init segment (moov/ftyp box
    // with the codec config) via EXT-X-MAP; every fragment after it is a bare
    // moof/mdat pair that only makes sense once that init segment precedes it.
    const initSegmentMatch = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlistText);
    const initSegmentUrl = initSegmentMatch ? new URL(initSegmentMatch[1], media.url).toString() : null;

    res.writeHead(200, { ...corsHeaders, 'Content-Type': media.mimeType });
    if (initSegmentUrl) {
      const init = await fetchImpl(initSegmentUrl, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
      if (!init.ok) throw new Error(`SoundCloud init segment returned HTTP ${init.status}`);
      res.write(Buffer.from(await init.arrayBuffer()));
    }
    for (const segment of segments) {
      if (controller.signal.aborted) return;
      const part = await fetchImpl(segment, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
      if (!part.ok) throw new Error(`SoundCloud segment returned HTTP ${part.status}`);
      res.write(Buffer.from(await part.arrayBuffer()));
    }
    res.end();
  }

  return {
    addToPlaylist,
    artist,
    createPlaylist,
    editablePlaylists,
    ensureClientId,
    feed,
    getMode,
    isSoundCloudId,
    libraryCategory,
    likeStatus,
    login,
    logout,
    playlist,
    proxyStream,
    related,
    resolveTrack,
    search,
    setLike,
    setMode,
    status,
    suggestions
  };
}
