/**
 * Deterministic synthetic booru dataset for the browser preview and integration
 * tests. Media URLs are relative SVG placeholders served by the preview server,
 * so nothing here touches the real sites.
 */
import type { Rating } from '../shared/types.js';

export interface MockPostSeed {
  id: number;
  rating: Rating;
  tags: string[];
  artist: string;
  character: string;
  copyright: string;
  width: number;
  height: number;
  ext: string;
  score: number;
  daysAgo: number;
}

const GENERAL_TAGS = [
  'alternate_color',
  'blue_sky',
  'cityscape',
  'clouds',
  'digital_art',
  'forest',
  'gradient_background',
  'landscape',
  'night',
  'portrait',
  'simple_background',
  'sunset',
  'water',
  'window',
];

const ARTISTS = ['aurelia', 'birchwood', 'cobalt', 'delta_ray', 'ember', 'foxglove'];
const CHARACTERS = ['alba', 'cinder', 'harbor', 'juniper', 'kite', 'marlow'];
const COPYRIGHTS = ['original_series', 'skyline_project', 'tidewater'];

const RATING_CYCLE: Rating[] = ['general', 'general', 'safe', 'sensitive', 'questionable', 'general', 'explicit', 'safe'];

/** 24 deterministic posts - enough to exercise paging, filtering and the queue. */
export const MOCK_POSTS: MockPostSeed[] = Array.from({ length: 24 }, (_value, index) => {
  const rating = RATING_CYCLE[index % RATING_CYCLE.length] ?? 'general';
  const general = [
    GENERAL_TAGS[index % GENERAL_TAGS.length]!,
    GENERAL_TAGS[(index * 3 + 5) % GENERAL_TAGS.length]!,
    index % 4 === 0 ? 'abstract' : 'detailed',
  ];
  return {
    id: 1_500_000 + index * 37,
    rating,
    tags: [rating === 'explicit' ? 'explicit_theme' : 'safe_theme', ...general],
    artist: ARTISTS[index % ARTISTS.length]!,
    character: CHARACTERS[(index * 5) % CHARACTERS.length]!,
    copyright: COPYRIGHTS[(index * 2) % COPYRIGHTS.length]!,
    width: 900 + (index % 5) * 120,
    height: 1200 + (index % 3) * 150,
    ext: index % 7 === 0 ? 'png' : 'jpg',
    score: 12 + ((index * 17) % 180),
    daysAgo: index,
  };
});

export function mockMediaPath(id: number, ext: string): string {
  return `/mock/media/${id}.${ext === 'png' ? 'png' : 'jpg'}`;
}

export const MOCK_CREDENTIALS = {
  e621: { username: 'demo_e621', apiKey: 'e621-demo-key' },
  danbooru: { username: 'demo_danbooru', apiKey: 'danbooru-demo-key' },
  gelbooru: { userId: '4242', apiKey: 'gelbooru-demo-key' },
} as const;

/** Any key starting with `demo` is accepted, which keeps the preview easy to poke at. */
export function credentialsLookValid(siteType: 'e621' | 'danbooru' | 'gelbooru', provided: { username?: string; apiKey?: string; userId?: string }): boolean {
  const apiKey = provided.apiKey ?? '';
  if (!apiKey) return false;
  if (apiKey.startsWith('demo') || apiKey.includes('-demo-')) return true;
  const expected = MOCK_CREDENTIALS[siteType];
  if ('username' in expected && provided.username) return provided.username === expected.username && apiKey === expected.apiKey;
  if ('userId' in expected) return provided.userId === expected.userId && apiKey === expected.apiKey;
  return false;
}

/**
 * Pawchive creator archive fixture.
 *
 * The mirror links live in the post `content` HTML, exactly like the real sites:
 * every downloadable file is on somebody else's host, listed only as a URL. One
 * post deliberately links the site's own storage node (`n1.pawchive.pw`) and one
 * links a plain gallery page, so both edges of the link filter are demoable:
 * the first is never collected (it is a normal attachment), the second only with
 * the "every external link" filter.
 */
export interface MockCreatorPost {
  id: string;
  service: string;
  user: string;
  title: string;
  published: string;
  content: string;
  /** Primary file, plus attachments - the shape `/api/v1/…/post/{id}` returns. */
  files: Array<{ name: string; path: string; node: number | null }>;
}

export const MOCK_CREATOR = { service: 'fanbox', user: '1245946', name: 'Mock Creator' } as const;

const MEGA = 'https://mega.nz/file/AbCdEf12#9hIjKlMnOpQrStUvWxYz0123456789';
const DRIVE = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view?usp=sharing';
const PIXELDRAIN = 'https://pixeldrain.com/u/abcd1234';
const MEDIAFIRE = 'https://www.mediafire.com/file/xyz789/artpack.zip/file';
const CATBOX = 'https://catbox.moe/8f3a2b1c.psd';
const DROPBOX = 'https://www.dropbox.com/s/abcdef123456/sketchbook.cbz?dl=0';
const OWN_NODE = 'https://n1.pawchive.pw/data/d0/fe/d0fedede6a3c6d0214a20644274bd342f10893ce29c8b91387d815cca162e1aa.zip';
const GALLERY = 'https://example.com/gallery/1234';

export const MOCK_CREATOR_POSTS: MockCreatorPost[] = [
  {
    id: '12674481',
    service: MOCK_CREATOR.service,
    user: MOCK_CREATOR.user,
    title: 'September art pack (v2)',
    published: '2026-09-02T10:00:00',
    content: `<p>Thanks for the support! Everything is in the archive:</p>
      <p><a href="${MEGA}">MEGA</a> · <a href="${DRIVE}">Google Drive</a></p>
      <p>Mirror: ${PIXELDRAIN}</p>
      <p>Site copy: <a href="${OWN_NODE}">pawchive</a> · Gallery: <a href="${GALLERY}">gallery page</a></p>`,
    files: [
      { name: 'artpack-v2.zip', path: '/d0/fe/d0fedede6a3c6d0214a20644274bd342f10893ce29c8b91387d815cca162e1aa.zip', node: 2 },
      { name: 'cover.jpeg', path: '/d0/fe/d0fedede6a3c6d0214a20644274bd342f10893ce29c8b91387d815cca162e1aa.jpeg', node: 2 },
    ],
  },
  {
    id: '12641102',
    service: MOCK_CREATOR.service,
    user: MOCK_CREATOR.user,
    title: 'Sketch dump — week 35',
    published: '2026-08-30T09:12:00',
    content: `<h2>Downloads</h2><ul><li><a href="${MEDIAFIRE}">MediaFire (pack)</a></li>
      <li><a href="${PIXELDRAIN}">pixeldrain mirror</a></li></ul>
      <p>PSD file: ${CATBOX}</p>`,
    files: [{ name: 'sketches-35.zip', path: '/ab/cd/abcd00001111222233334444555566667777888899990000111122223333.zip', node: 1 }],
  },
  {
    id: '12619230',
    service: MOCK_CREATOR.service,
    user: MOCK_CREATOR.user,
    title: 'Full colour pack + brushes',
    published: '2026-08-24T18:45:00',
    content: `<p>Brushes are on Dropbox this time, the pack is on Drive.</p>
      <p><a href="${DROPBOX}">download</a> | <a href="${DRIVE}">pack</a></p>`,
    files: [{ name: 'colours.zip', path: '/12/34/1234abcd5678ef9012345678abcd000011112222333344445555666677778888.zip', node: 3 }],
  },
  {
    id: '12598347',
    service: MOCK_CREATOR.service,
    user: MOCK_CREATOR.user,
    title: 'Wallpaper batch (4K)',
    published: '2026-08-19T08:00:00',
    content: `<p><a href="${MEGA}">MEGA folder</a> — same pack as last time, re-uploaded.</p>
      <p>Preview only: <a href="${GALLERY}">gallery</a></p>`,
    files: [{ name: 'wallpapers.zip', path: '/56/78/5678abcd0000111122223333444455556666777788889999000011112222.zip', node: 1 }],
  },
  {
    id: '12577311',
    service: MOCK_CREATOR.service,
    user: MOCK_CREATOR.user,
    title: 'Comic chapter 12',
    published: '2026-08-12T21:30:00',
    content: `<p>CBZ is on Dropbox, and the raw pages are on catbox.</p>
      <p><a href="${DROPBOX}">CBZ</a></p><p><a href="${CATBOX}">raw PSD</a></p>`,
    files: [{ name: 'chapter12.cbz', path: '/90/ab/90ab1234cdef5678901234567890abcd1234567890abcdef123456789012345.cbz', node: 2 }],
  },
  {
    id: '12554890',
    service: MOCK_CREATOR.service,
    user: MOCK_CREATOR.user,
    title: 'Timelapse + project files',
    published: '2026-08-05T14:20:00',
    content: `<p>Video is up on MediaFire, project files on Pixeldrain.</p>
      <p><a href="${MEDIAFIRE}">MediaFire</a></p><p>${PIXELDRAIN}</p>`,
    files: [{ name: 'timelapse.mp4', path: '/cd/ef/cdef1234567890abcdef1234567890abcdef1234567890abcdef123456789012.mp4', node: 3 }],
  },
];
