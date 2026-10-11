/*
 * Copyright (C) 2026 SFG545
 *
 * This file is part of Orchard.
 *
 * Orchard is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version.
 *
 * Orchard is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See the GNU Affero General Public License for more
 * details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Orchard. If not, see <https://www.gnu.org/licenses/>.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { Server } from 'socket.io';
import { createPlaylistMutations } from './playlistMutations.js';
import { normalizePodcastDetail, normalizePodcastFeed } from '../catalog/podcastCatalog.js';
import { createOrchardConnectServer } from '../connect/orchardConnectServer.js';
import { registerCacheBridge } from './cacheBridge.js';
import { registerYouTubeHistoryBridge } from './youtubeHistoryBridge.js';
import { registerYouTubeLikesBridge } from './youtubeLikesBridge.js';
import { registerArtistGenreBridge } from './artistGenreBridge.js';
import { registerSponsorBlockBridge } from './sponsorBlockBridge.js';
import { playbackAudioBitrate } from '../playback/playbackFormats.js';
import { isAgeGatePlaybackError } from '../playback/playbackErrors.js';
import { isAgeGateRiskTrack } from '../playback/musicVideoFallback.js';
import {
  shouldPreferBrowserPlayback,
  shouldTryAuthenticatedAgeGate
} from '../playback/playbackRouting.js';
let fontFamiliesPromise = null;

/** Installed font families (Windows), read once and cached. */
function systemFontFamilies() {
  fontFamiliesPromise ||= new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Drawing;'
      + '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name } | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        fontFamiliesPromise = null;
        return resolve([]);
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve([...new Set(Array.isArray(parsed) ? parsed : [parsed])].filter(Boolean).sort((a, b) => a.localeCompare(b)));
      } catch {
        fontFamiliesPromise = null;
        resolve([]);
      }
    });
  });
  return fontFamiliesPromise;
}

/** Starts the renderer-only loopback transport and returns its owned close handle. */
export async function startBridgeServer({
  bridgeError,
  catalogAudioItems,
  continueMusicPlaylistWithFallback,
  ensureSignedIn,
  fetchBrowserMusicHome,
  fetchFeed,
  fetchMusicHomeFeed,
  fetchMusicLibraryCategory,
  fetchMusicLibraryFeed,
  findMusicVideoFallback,
  getBrowserInnertube,
  getGuestInnertube,
  getInnertube,
  hasBrowserLoginCookie,
  cachedArtistResult, hydrateArtist,
  musicClientForBrowse,
  musicClientForPlayback,
  normalizeAlbum,
  normalizeArtistSection,
  normalizePlaylist,
  normalizePlaylistPage,
  normalizeSearch,
  normalizeTrackInfo,
  personalizedRadio,
  playback,
  preferredAudioTrack,
  proxyHlsResource,
  proxyStream,
  publicAuthState,
  releaseAlbumMatches,
  releaseRadarForArtists,
  refreshBrowserAuth,
  resolveFutureAlbum,
  resolveArtistGenre,
  resolveItunesAlbum,
  resolveLyrics,
  resolveMusicCollectionWithFallback,
  resolveStream,
  restoreCachedSignIn,
  searchCatalog,
  shelfItems,
  signOutAuth,
  startAccountSwitch,
  startBrowserSignIn,
  subscribedArtists,
  setArtistSubscription,
  soundcloud,
  youtubeHistory,
  youtubeLikes,
  connectDevicesPath
}) {
  const playlistMutations = createPlaylistMutations({ ensureSignedIn, refreshBrowserAuth, soundcloud });
  const streamCorsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'
  };
  const httpServer = createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    if (requestUrl.pathname === '/hls') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, streamCorsHeaders);
        res.end();
        return;
      }
      try {
        await proxyHlsResource(requestUrl.searchParams.get('url') || '', req, res);
      } catch (error) {
        console.warn(`HLS proxy failed: ${error.message}`);
        if (res.headersSent) {
          if (!res.writableEnded) res.destroy(error);
          return;
        }
        res.writeHead(502, {
          ...streamCorsHeaders,
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (requestUrl.pathname.startsWith('/stream/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, streamCorsHeaders);
        res.end();
        return;
      }
      const videoId = decodeURIComponent(requestUrl.pathname.replace('/stream/', ''));
      try {
        await proxyStream(videoId, req, res);
      } catch (error) {
        console.warn(`Stream proxy failed for ${videoId}: ${error.message}`);
        if (res.headersSent) {
          if (!res.writableEnded) res.destroy(error);
          return;
        }
        res.writeHead(502, {
          ...streamCorsHeaders,
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (requestUrl.pathname.startsWith('/sc-stream/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, streamCorsHeaders);
        res.end();
        return;
      }
      const trackId = decodeURIComponent(requestUrl.pathname.replace('/sc-stream/', ''));
      try {
        await soundcloud.proxyStream(trackId, req, res, streamCorsHeaders);
      } catch (error) {
        console.warn(`SoundCloud stream failed for ${trackId}: ${error.message}`);
        if (res.headersSent) {
          if (!res.writableEnded) res.destroy(error);
          return;
        }
        res.writeHead(502, { ...streamCorsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (requestUrl.pathname === '/fonts') {
      const families = await systemFontFamilies();
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: families }));
      return;
    }

    // Small JSON control surface used by the renderer's source selector.
    if (requestUrl.pathname.startsWith('/sc/')) {
      const jsonHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Content-Type': 'application/json'
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, jsonHeaders);
        res.end();
        return;
      }
      try {
        const action = requestUrl.pathname.replace('/sc/', '');
        let data;
        if (action === 'status') data = await soundcloud.status();
        else if (action === 'login') data = await soundcloud.login();
        else if (action === 'logout') data = await soundcloud.logout();
        else if (action === 'mode') {
          const mode = requestUrl.searchParams.get('set');
          if (mode) soundcloud.setMode(mode);
          data = await soundcloud.status();
        } else {
          res.writeHead(404, jsonHeaders);
          res.end(JSON.stringify({ error: 'Unknown action' }));
          return;
        }
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ ok: true, data }));
      } catch (error) {
        res.writeHead(500, jsonHeaders);
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    res.writeHead(404, streamCorsHeaders);
    res.end();
  });

  const ioServer = new Server(httpServer, { cors: { origin: '*' } });
  const connectServer = await createOrchardConnectServer({
    Server,
    desktopIo: ioServer,
    deviceStorePath: connectDevicesPath
  });

  function isAuthenticationCredentialError(error) {
    return Number(error?.status) === 401 || /\b401\b|required authentication credential/i.test(error?.message || '');
  }

  async function musicUpNext(videoId) {
    const primary = await musicClientForBrowse();

    try {
      return await primary.music.getUpNext(videoId, true);
    } catch (error) {
      if (!isAuthenticationCredentialError(error)) throw error;

      await refreshBrowserAuth();
      const browser = await getBrowserInnertube();
      if (browser && browser !== primary) {
        try {
          return await browser.music.getUpNext(videoId, true);
        } catch (browserError) {
          if (!isAuthenticationCredentialError(browserError)) throw browserError;
        }
      }

      const guest = await getGuestInnertube();
      if (guest !== primary) return guest.music.getUpNext(videoId, true);
      throw error;
    }
  }

  async function resolveTrackRequest({ videoId, supportedMimes = [], supportedVideoMimes = [], mediaKind = 'audio', preload = false, refreshStream = false, avoidItags = [], avoidMimeTypes = [], ...trackHint }) {
    if (soundcloud.isSoundCloudId(videoId)) {
      return soundcloud.resolveTrack(videoId, `http://127.0.0.1:${httpServer.address().port}/sc-stream`);
    }
    const preferBrowserPlayback = shouldPreferBrowserPlayback(
      trackHint,
      playback.androidVrCooldownActive()
    );
    const [yt, searchYt] = await Promise.all([
      musicClientForPlayback(preferBrowserPlayback),
      getGuestInnertube()
    ]);
    const wantsVideo = mediaKind === 'video';
    const resolvedVideoId = wantsVideo
      ? videoId
      : await preferredAudioTrack(searchYt, { ...trackHint, videoId });
    let musicVideoFallbackPromise;

    function findMusicVideoFallbackOnce() {
      musicVideoFallbackPromise ||= findMusicVideoFallback(searchYt, { ...trackHint, videoId });
      return musicVideoFallbackPromise;
    }

    async function resolveCandidate(candidateId, { playAsVideo = false, authenticatedAgeGate = false } = {}) {
      const streamAsVideo = wantsVideo || playAsVideo;
      const resolvedInfo = authenticatedAgeGate
        ? null
        : await playback.playbackInfo(candidateId, {
            yt,
            preferBrowserAuth: preferBrowserPlayback
          });
      const normalizedInfo = resolvedInfo
        ? normalizeTrackInfo(candidateId, resolvedInfo.info)
        : {
            id: candidateId,
            title: trackHint.title || 'Untitled',
            artist: trackHint.artist || trackHint.artists?.[0] || '',
            durationSeconds: Number(trackHint.durationSeconds || 0),
            thumbnail: trackHint.thumbnail || '',
            isLive: false,
            viewCount: 0
          };
      const fallbackTargetDuration = playAsVideo
        ? Number(trackHint.fallbackTargetDurationSeconds || trackHint.durationSeconds || 0)
        : 0;
      if (fallbackTargetDuration && Math.abs(normalizedInfo.durationSeconds - fallbackTargetDuration) > 5) {
        throw new Error('The matching music video differs from the song by more than five seconds');
      }
      const stream = await resolveStream(candidateId, {
        supportedMimes: streamAsVideo ? supportedVideoMimes : supportedMimes,
        supportedAudioMimes: supportedMimes,
        mediaKind: streamAsVideo ? 'video' : 'audio',
        preferInlineVideo: playAsVideo,
        requiresAuth: Boolean(trackHint.isUpload),
        authenticatedAgeGate,
        lowPriority: Boolean(preload),
        refreshStream: Boolean(refreshStream),
        avoidItags,
        avoidMimeTypes,
        playbackClient: resolvedInfo?.yt,
        playbackInfo: resolvedInfo?.info,
        ...trackHint
      });
      const streamBaseUrl = `http://127.0.0.1:${httpServer.address().port}/stream/${encodeURIComponent(candidateId)}`;
      return {
        ...normalizedInfo,
        youtubeVideoId: candidateId,
        mediaKind: streamAsVideo ? 'video' : 'audio',
        mimeType: stream.format.mimeType,
        itag: stream.format.itag,
        bitrate: playbackAudioBitrate(stream, streamAsVideo ? 'video' : 'audio'),
        audioItag: stream.audioFormat?.itag || null,
        audioStreamUrl: streamAsVideo && stream.audioFormat
          ? `${streamBaseUrl}?itag=${stream.audioFormat.itag}&media=audio`
          : '',
        playbackSource: stream.playbackSource || 'youtube',
        authenticatedPlayback: Boolean(stream.authenticated),
        externalSource: stream.externalSource || '',
        streamUrl: `${streamBaseUrl}?itag=${stream.format.itag}&media=${streamAsVideo ? 'video' : 'audio'}`, streamExpiresAt: stream.expiresAt || 0
      };
    }

    async function resolveMusicVideoFallback(fallback, reason) {
      console.warn(`Using ${reason} music video ${fallback.id} for age-gated track ${videoId}`);
      return {
        ...await resolveCandidate(fallback.id, { playAsVideo: true }),
        id: trackHint.originalVideoId || videoId,
        musicVideoAudioFallback: true,
        musicVideoFallbackId: fallback.id
      };
    }

    if (!wantsVideo && !trackHint.explicit && isAgeGateRiskTrack(trackHint)) {
      const fallback = await findMusicVideoFallbackOnce();
      if (fallback) {
        try {
          return await resolveMusicVideoFallback(fallback, 'proactive');
        } catch (fallbackError) {
          console.warn(`Proactive music-video fallback ${fallback.id} failed: ${fallbackError.message}`);
        }
      }
    }

    try {
      const resolved = await resolveCandidate(resolvedVideoId, {
        playAsVideo: Boolean(trackHint.musicVideoAudioFallback)
      });
      if (!trackHint.musicVideoAudioFallback) return resolved;

      return {
        ...resolved,
        id: trackHint.originalVideoId || videoId,
        musicVideoAudioFallback: true,
        musicVideoFallbackId: videoId
      };
    } catch (error) {
      if (wantsVideo || !isAgeGatePlaybackError(error)) throw error;
      if (shouldTryAuthenticatedAgeGate(error, {
        wantsVideo,
        signedIn: hasBrowserLoginCookie()
      })) {
        try {
          return await resolveCandidate(resolvedVideoId, { authenticatedAgeGate: true });
        } catch (authenticatedError) {
          authenticatedError.ageGateBlocked = true;
          console.warn(`Authenticated age-gate playback failed: ${authenticatedError.message}`);
          error = authenticatedError;
        }
      }
      const fallback = await findMusicVideoFallbackOnce();
      if (fallback) {
        try {
          return await resolveMusicVideoFallback(fallback, 'duration-matched');
        } catch (fallbackError) {
          console.warn(`Duration-matched music-video fallback ${fallback.id} failed: ${fallbackError.message}`);
        }
      }

      const alternateAudioId = await preferredAudioTrack(searchYt, {
        ...trackHint, videoId, preferAudioOnly: true, retryAlternateAudio: true, excludedVideoIds: [resolvedVideoId]
      });
      if (alternateAudioId !== videoId && alternateAudioId !== resolvedVideoId) {
        try {
          return await resolveCandidate(alternateAudioId);
        } catch (alternateError) {
          if (!isAgeGatePlaybackError(alternateError)) throw alternateError;
          error = alternateError;
        }
      }
      if (resolvedVideoId !== videoId) return resolveCandidate(videoId);
      throw error;
    }
  }

  async function resolveReleasedAlbum(yt, release) {
    if (!yt || release.releaseDaysFromToday > 0) return release;

    try {
      const search = await yt.music.search(`${release.artist} ${release.title}`, { type: 'album' });
      const albums = normalizeSearch(search, release.title).sections
        .flatMap((section) => section.items || [])
        .filter((item) => item.type === 'album');
      const match = albums.find((album) => releaseAlbumMatches(release, album));
      if (!match) return release;

      return {
        ...release,
        ...match,
        title: match.title || release.title,
        artist: match.artist || match.subtitle || release.artist,
        artists: match.artists?.length ? match.artists : release.artists,
        thumbnail: match.thumbnail || release.thumbnail,
        releaseDate: release.releaseDate,
        releaseDateText: release.releaseDateText,
        releaseDaysFromToday: release.releaseDaysFromToday,
        releaseTiming: release.releaseTiming,
        releaseTimingLabel: release.releaseTimingLabel,
        releaseResolved: true,
        sourceRelease: release
      };
    } catch (error) {
      console.warn(`Could not resolve release ${release.artist} - ${release.title}: ${error.message}`);
      return release;
    }
  }
  const soundcloudBrowseId = (payload) => {
    const id = payload?.browseId || payload?.browsePayload?.browseId || '';
    return soundcloud.isSoundCloudId(id) ? id : '';
  };

  /** Folds SoundCloud account state into the YouTube-shaped auth state per source mode. */
  async function sourceAuthState() {
    const base = publicAuthState();
    const mode = soundcloud.getMode();
    if (mode === 'ytm') return { ...base, source: mode };
    const sc = await soundcloud.status().catch(() => ({ signedIn: false, user: null }));
    if (mode === 'sc') {
      return {
        signedIn: sc.signedIn,
        status: sc.signedIn ? 'signed_in' : 'signed_out',
        pending: null,
        error: '',
        user: sc.user,
        source: mode,
        soundcloud: sc
      };
    }
    return {
      ...base,
      signedIn: Boolean(base.signedIn || sc.signedIn),
      status: base.signedIn || sc.signedIn ? 'signed_in' : base.status,
      user: base.signedIn ? base.user : sc.user || base.user,
      source: mode,
      soundcloud: sc
    };
  }

  function interleave(a = [], b = []) {
    const out = [];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i]) out.push(a[i]);
      if (b[i]) out.push(b[i]);
    }
    return out;
  }

  function mergeSearchResults(primary, secondary) {
    const order = ['songs', 'videos', 'albums', 'artists', 'playlists'];
    const byKey = new Map();
    for (const section of [...(primary?.sections || []), ...(secondary?.sections || [])]) {
      const existing = byKey.get(section.key);
      byKey.set(section.key, existing ? { ...existing, items: interleave(existing.items, section.items) } : section);
    }
    const sections = [...byKey.values()].sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key));
    return { ...(primary || secondary), sections };
  }

  ioServer.on('connection', (socket) => {
    registerYouTubeHistoryBridge({
      socket,
      youtubeHistory: {
        start: (payload) => soundcloud.isSoundCloudId(payload?.videoId) ? { recorded: false } : youtubeHistory.start(payload),
        update: (payload) => youtubeHistory.update(payload)
      }
    });
    registerYouTubeLikesBridge({
      socket,
      bridgeError,
      youtubeLikes: {
        status: (payload) => soundcloud.isSoundCloudId(payload?.videoId) ? soundcloud.likeStatus(payload.videoId) : youtubeLikes.status(payload),
        set: (payload) => soundcloud.isSoundCloudId(payload?.videoId) ? soundcloud.setLike(payload.videoId, payload.liked) : youtubeLikes.set(payload)
      }
    });
    socket.emit('bridge:ready', { port: httpServer.address().port });
    connectServer.registerDesktop(socket);
    registerCacheBridge({ socket, bridgeError, playback, resolveTrackRequest, normalizeTrackInfo });
    registerArtistGenreBridge({ socket, bridgeError, resolveArtistGenre });
    registerSponsorBlockBridge({ socket });
    playlistMutations.register(socket, bridgeError);

    socket.on('music:search', async ({ query, filter = 'songs' }, reply) => {
      try {
        const mode = soundcloud.getMode();
        const searchYouTube = async () => {
          const yt = await getGuestInnertube();
          const loadTrackPopularity = async (videoId) => {
            const info = await yt.getBasicInfo(videoId);
            return info?.basic_info?.view_count || 0;
          };
          return searchCatalog(yt.music, query, filter, loadTrackPopularity);
        };

        if (mode === 'sc') {
          reply({ ok: true, data: await soundcloud.search(query, filter) });
        } else if (mode === 'both') {
          const [youtube, sc] = await Promise.allSettled([searchYouTube(), soundcloud.search(query, filter)]);
          if (youtube.status === 'rejected' && sc.status === 'rejected') throw youtube.reason;
          reply({ ok: true, data: mergeSearchResults(youtube.value, sc.value) });
        } else {
          reply({ ok: true, data: await searchYouTube() });
        }
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:radio', async (_payload, reply) => {
      try {
        reply({ ok: true, data: await personalizedRadio() });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:podcasts', async (_payload, reply) => {
      try {
        const yt = await musicClientForBrowse();
        const podcasts = await resolveMusicCollectionWithFallback(yt, 'podcast', { browseId: 'FEmusic_podcasts' });
        reply({ ok: true, data: normalizePodcastFeed(podcasts.data) });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:podcast', async (payload, reply) => {
      try {
        const yt = await musicClientForBrowse();
        const podcast = await resolveMusicCollectionWithFallback(yt, 'podcast', payload);
        reply({ ok: true, data: normalizePodcastDetail(podcast.data, podcast.browseId) });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:release-radar', async (_payload, reply) => {
      try {
        await refreshBrowserAuth();
        const artists = await subscribedArtists();
        const releases = await releaseRadarForArtists(artists);
        const yt = await musicClientForBrowse().catch(() => null);
        const resolved = [];

        for (const release of releases) {
          resolved.push(await resolveReleasedAlbum(yt, release));
        }

        reply({ ok: true, data: { artists, releases: resolved } });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    /** Likes = every source YouTube Music exposes (Liked Music playlist, raw library page, library Songs), merged by video id. */
    async function fetchYouTubeLikes(yt) {
      const fromPlaylist = async () => {
        const playlist = await resolveMusicCollectionWithFallback(yt, 'playlist', { browseId: 'VLLM' });
        const first = normalizePlaylist(playlist);
        const tracks = [...first.tracks];
        let continuation = first.continuation;
        for (let i = 0; continuation && i < 500; i += 1) {
          const page = normalizePlaylistPage(await continueMusicPlaylistWithFallback(yt, continuation), tracks.length);
          tracks.push(...page.tracks);
          continuation = page.continuation;
        }
        return tracks;
      };
      const fromInnertube = async () => {
        let page = await yt.music.getPlaylist('VLLM');
        const tracks = [...(page.items || [])];
        for (let i = 0; page.has_continuation && i < 500; i += 1) {
          page = await page.getContinuation();
          tracks.push(...(page.items || []));
        }
        const mapped = tracks.map((t) => ({ id: t.id || t.video_id, title: t.title?.text || t.title || '', type: t.type }));
        const noId = mapped.filter((t) => !t.id);
        const ids = mapped.filter((t) => t.id).map((t) => t.id);
        const dupes = ids.length - new Set(ids).size;
        try {
          fs.appendFileSync(path.join(os.tmpdir(), 'orchard-likes.log'),
            `  innertube raw=${mapped.length} noId=${noId.length} dupIds=${dupes} types=${[...new Set(mapped.map((t) => t.type))].join(',')} total_items=${page.header?.total_items ?? page.total_items ?? '?'} noIdTitles=${JSON.stringify(noId.slice(0, 40).map((t) => t.title))}
`);
        } catch { /* best effort */ }
        return mapped.filter((t) => t.id);
      };
      const sources = {
        playlist: fromPlaylist(),
        raw: fetchMusicLibraryCategory(yt, 'likes'),
        songs: fetchMusicLibraryCategory(yt, 'songs'),
        innertube: fromInnertube()
      };
      const names = Object.keys(sources);
      const results = await Promise.allSettled(Object.values(sources));
      const seen = new Set();
      const merged = [];
      const full = [];
      results.forEach((r, idx) => {
        if (r.status !== 'fulfilled') return;
        for (const item of r.value) {
          if (!item?.id || seen.has(item.id)) continue;
          seen.add(item.id);
          // The innertube list is only a safety net for ids; it lacks the full item shape.
          (names[idx] === 'innertube' ? full : merged).push(names[idx] === 'innertube' ? item : { ...item, fromLikes: true });
        }
      });
      const summary = names.map((n, idx) => `${n}=${results[idx].status === 'fulfilled' ? results[idx].value.length : 'ERR ' + results[idx].reason?.message}`).join(' ');
      const line = `[${new Date().toISOString()}] YT likes: ${summary} merged=${merged.length} innertube-only=${full.length}
`;
      console.log(line.trim());
      try { fs.appendFileSync(path.join(os.tmpdir(), 'orchard-likes.log'), line); } catch { /* best effort */ }
      return merged;
    }

    async function fetchYouTubeLibrary(yt, title) {
      return String(title || '').trim().toLowerCase() === 'likes' ? fetchYouTubeLikes(yt) : fetchMusicLibraryCategory(yt, title);
    }

    socket.on('music:library-category', async ({ title }, reply) => {
      try {
        const mode = soundcloud.getMode();
        if (mode === 'sc') return reply({ ok: true, data: await soundcloud.libraryCategory(title) });
        if (mode === 'both') {
          const [youtube, sc] = await Promise.allSettled([
            ensureSignedIn().then((yt) => fetchYouTubeLibrary(yt, title)),
            soundcloud.libraryCategory(title)
          ]);
          if (youtube.status === 'rejected' && sc.status === 'rejected') throw youtube.reason;
          if (youtube.status === 'rejected') console.warn(`YT library ${title} failed: ${youtube.reason?.message}`);
          if (sc.status === 'rejected') console.warn(`SC library ${title} failed: ${sc.reason?.message}`);
          return reply({ ok: true, data: [...(youtube.value || []), ...(sc.value || [])] });
        }
        const yt = await ensureSignedIn();
        reply({ ok: true, data: await fetchYouTubeLibrary(yt, title) });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:subscribed-artists', async (_payload, reply) => {
      try {
        const mode = soundcloud.getMode();
        if (mode === 'sc') return reply({ ok: true, data: await soundcloud.libraryCategory('artists') });
        if (mode === 'both') {
          const [youtube, sc] = await Promise.allSettled([
            refreshBrowserAuth().then(() => subscribedArtists()),
            soundcloud.libraryCategory('artists')
          ]);
          if (youtube.status === 'rejected' && sc.status === 'rejected') throw youtube.reason;
          return reply({ ok: true, data: [...(youtube.value || []), ...(sc.value || [])] });
        }
        await refreshBrowserAuth();
        reply({ ok: true, data: await subscribedArtists() });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:set-artist-subscription', async ({ browseId, subscribed }, reply) => {
      try {
        await refreshBrowserAuth();
        const result = await setArtistSubscription(browseId, Boolean(subscribed));
        reply({ ok: true, data: { ...result, artists: await subscribedArtists() } });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('auth:status', async (_payload, reply) => {
      try {
        await refreshBrowserAuth();
        const yt = await getInnertube();
        await restoreCachedSignIn(yt);
      } catch {
        // fall through to the state we already have
      }
      reply({ ok: true, data: await sourceAuthState() });
    });

    socket.on('auth:login', async (_payload, reply) => {
      try {
        const mode = soundcloud.getMode();
        if (mode === 'sc' || (mode === 'both' && publicAuthState().signedIn)) await soundcloud.login();
        else await startLogin({ startBrowserSignIn, publicAuthState });
        reply({ ok: true, data: await sourceAuthState() });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('auth:logout', async (_payload, reply) => {
      try {
        if (soundcloud.getMode() === 'sc') await soundcloud.logout();
        else await signOutAuth();
        reply({ ok: true, data: await sourceAuthState() });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('auth:switch-account', async (_payload, reply) => {
      try {
        reply({ ok: true, data: await startAccountSwitch() });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:home', async (_payload, reply) => {
      try {
        const mode = soundcloud.getMode();
        const loadYouTubeHome = async () => {
          if (!hasBrowserLoginCookie()) await refreshBrowserAuth();
          const yt = await ensureSignedIn();
          const [home, library] = await Promise.all([
            fetchFeed('Music home', () => fetchMusicHomeFeed(yt), hasBrowserLoginCookie() ? fetchBrowserMusicHome : null),
            fetchMusicLibraryFeed(yt)
          ]);
          return { home: home.feed, library: library.feed, warnings: [home.error, library.error].filter(Boolean) };
        };
        const empty = () => ({ home: { sections: [], filters: [] }, library: { sections: [], filters: [] }, warnings: [] });

        const youtube = mode === 'sc'
          ? empty()
          : mode === 'both'
            ? await loadYouTubeHome().catch(empty)
            : await loadYouTubeHome();
        const sc = mode === 'ytm' ? null : await soundcloud.feed().catch((error) => {
          youtube.warnings.push(`SoundCloud: ${bridgeError(error)}`);
          return null;
        });

        reply({
          ok: true,
          data: {
            home: sc ? { ...youtube.home, sections: [...(youtube.home.sections || []), ...sc.home.sections] } : youtube.home,
            library: sc ? { ...youtube.library, sections: [...(youtube.library.sections || []), ...sc.library.sections] } : youtube.library,
            auth: await sourceAuthState(),
            warnings: youtube.warnings
          }
        });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:playlist', async (payload, reply) => {
      try {
        const scId = soundcloudBrowseId(payload);
        if (scId) return reply({ ok: true, data: { ...await soundcloud.playlist(scId), editable: false } });
        const yt = await musicClientForBrowse();
        const [playlist, youtubePlaylist] = await Promise.all([
          resolveMusicCollectionWithFallback(yt, 'playlist', payload),
          yt.getPlaylist(payload?.browseId).catch(() => null)
        ]);
        const normalized = normalizePlaylist(playlist, youtubePlaylist?.info?.total_items);
        reply({ ok: true, data: { ...normalized, editable: false } });
        void playlistMutations.canEdit(normalized.browseId, normalized.tracks?.[0]?.id)
          .then((editable) => socket.emit('music:playlist:editable', { browseId: normalized.browseId, editable }))
          .catch(() => {});
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:playlist:more', async (payload, reply) => {
      try {
        const continuation = payload?.continuation;
        if (!continuation) throw new Error('Playlist continuation is missing.');

        const startIndex = Number(payload?.startIndex) || 0;
        const yt = await musicClientForBrowse();
        const page = await continueMusicPlaylistWithFallback(yt, continuation);

        reply({ ok: true, data: normalizePlaylistPage(page, startIndex) });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:album', async (payload, reply) => {
      try {
        const scId = soundcloudBrowseId(payload);
        if (scId) return reply({ ok: true, data: await soundcloud.playlist(scId) });
        const yt = await musicClientForBrowse();
        const album = await resolveMusicCollectionWithFallback(yt, 'album', payload);
        reply({ ok: true, data: normalizeAlbum(album.data, album.browseId) });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:future-album', async (payload, reply) => {
      try {
        reply({ ok: true, data: await resolveFutureAlbum(payload) });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:itunes-album', async (payload, reply) => {
      try {
        reply({ ok: true, data: await resolveItunesAlbum(payload?.albumId) });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:artist', async (payload, reply) => {
      try {
        const scId = soundcloudBrowseId(payload);
        if (scId) return reply({ ok: true, data: await soundcloud.artist(scId) });
        const payloadCached = cachedArtistResult(payload, { hydratedOnly: true });
        if (payloadCached) return reply({ ok: true, data: payloadCached });
        const yt = await musicClientForBrowse();
        const artist = await resolveMusicCollectionWithFallback(yt, 'artist', payload);
        const cached = cachedArtistResult(artist.browseId, { hydratedOnly: true });
        reply({ ok: true, data: cached || await hydrateArtist(artist) });
      } catch (error) { reply({ ok: false, error: bridgeError(error) }); }
    });
    socket.on('music:artist:section', async (payload, reply) => {
      try {
        if (soundcloudBrowseId(payload)) return reply({ ok: true, data: { ...(payload?.section || {}), items: payload?.section?.items || [] } });
        reply({ ok: true, data: await normalizeArtistSection(await resolveMusicCollectionWithFallback(await musicClientForBrowse(), 'artist', payload), payload?.section) });
      } catch (error) { reply({ ok: false, error: bridgeError(error) }); }
    });
    socket.on('music:suggestions', async ({ query }, reply) => {
      try {
        const yt = await getGuestInnertube();
        const suggestions = await yt.music.getSearchSuggestions(query);
        reply({
          ok: true,
          data: suggestions.flatMap((section) => shelfItems(section)).slice(0, 8)
        });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });

    socket.on('music:track', async ({ videoId, supportedMimes = [], supportedVideoMimes = [], mediaKind = 'audio', preload = false, refreshStream = false, avoidItags = [], avoidMimeTypes = [], ...trackHint }, reply) => {
      try {
        reply({
          ok: true,
          data: await resolveTrackRequest({ videoId, supportedMimes, supportedVideoMimes, mediaKind, preload, refreshStream, avoidItags, avoidMimeTypes, ...trackHint })
        });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });
    socket.on('music:lyrics', async ({ provider = 'amlyrics', ...track }, reply) => {
      try {
        reply({ ok: true, data: await resolveLyrics(track, provider) });
      } catch {
        reply({ ok: true, data: { status: 'unavailable', mode: '', lines: [], source: provider } });
      }
    });

    socket.on('music:up-next', async ({ videoId }, reply) => {
      try {
        if (soundcloud.isSoundCloudId(videoId)) return reply({ ok: true, data: await soundcloud.related(videoId) });
        const upNext = await musicUpNext(videoId);
        reply({
          ok: true,
          data: catalogAudioItems(shelfItems(upNext))
        });
      } catch (error) {
        reply({ ok: false, error: bridgeError(error) });
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  // The main-process lifecycle owns this handle and calls `close()` before quitting.
  return {
    port: httpServer.address().port,
    emit(event, payload) {
      ioServer.emit(event, payload);
    },
    close() {
      connectServer.close();
      ioServer.close();
      httpServer.close();
    }
  };
}

async function startLogin({ startBrowserSignIn }) { return startBrowserSignIn(); }
