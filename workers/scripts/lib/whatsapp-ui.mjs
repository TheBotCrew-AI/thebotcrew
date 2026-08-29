/**
 * The WhatsApp look, shared by the screenshot renderer and the client report: the iOS
 * chrome (status bar, header, composer), the bubbles, the wallpaper, and the text helpers.
 * Everything is inline SVG/CSS — the files that use it must stay dependency-free and
 * openable from disk.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';

export const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** WhatsApp's own markup: *bold*, _italic_, ~strike~, plus links. Applied after escaping. */
export function wa(text) {
  let t = esc(text);
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, '$1<b>$2</b>');
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, '$1<i>$2</i>');
  t = t.replace(/(^|[\s(])~([^~\n]+)~(?=[\s.,;:!?)]|$)/g, '$1<s>$2</s>');
  t = t.replace(/(https?:\/\/[^\s<]+)/g, '<a>$1</a>');
  return t;
}

export function timeLabel(iso, tz) {
  return new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz })
    .format(new Date(iso))
    .replace(/\s?([ap])\.?\s?m\.?/i, ' $1.m.')
    .replace(/^0/, '');
}

export function initials(name) {
  return name
    .replace(/^dr[a]?\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export function avatarDataUri(file) {
  if (!file) return null;
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) {
    console.error(`--avatar: no existe ${path}`);
    process.exit(2);
  }
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[extname(path).toLowerCase()];
  return `data:${mime ?? 'image/png'};base64,${readFileSync(path).toString('base64')}`;
}

export const ICON = {
  back: '<svg width="12" height="20" viewBox="0 0 12 20"><path d="M10.5 1.5 2 10l8.5 8.5" fill="none" stroke="#007aff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  video: '<svg width="26" height="18" viewBox="0 0 26 18"><rect x="1" y="1" width="16" height="16" rx="4" fill="none" stroke="#007aff" stroke-width="1.8"/><path d="M17 7l7-4v12l-7-4z" fill="none" stroke="#007aff" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  phone: '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z" fill="none" stroke="#007aff" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  ticks: '<svg width="16" height="11" viewBox="0 0 16 11"><path d="M1 6l3 3 6-7M6 9l1 1 8-8" fill="none" stroke="#53bdeb" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M11 3v16M3 11h16" stroke="#007aff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  sticker: '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9v-1l-8 8h-1z" fill="none" stroke="#8e8e93" stroke-width="1.7"/><path d="M13 21c0-4 4-8 8-8" fill="none" stroke="#8e8e93" stroke-width="1.7"/><circle cx="9" cy="10" r="1.2" fill="#8e8e93"/><circle cx="15" cy="10" r="1.2" fill="#8e8e93"/><path d="M8.5 14c1 1.3 2.2 2 3.5 2s2.5-.7 3.5-2" fill="none" stroke="#8e8e93" stroke-width="1.5" stroke-linecap="round"/></svg>',
  camera: '<svg width="24" height="22" viewBox="0 0 24 22"><path d="M8 3h8l1.6 2.8H21a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7.8a2 2 0 0 1 2-2h3.4z" fill="none" stroke="#007aff" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12.5" r="4" fill="none" stroke="#007aff" stroke-width="1.7"/></svg>',
  mic: '<svg width="16" height="22" viewBox="0 0 16 22"><rect x="4.5" y="1" width="7" height="12" rx="3.5" fill="none" stroke="#007aff" stroke-width="1.7"/><path d="M1.5 10a6.5 6.5 0 0 0 13 0M8 16.5V21M5 21h6" fill="none" stroke="#007aff" stroke-width="1.7" stroke-linecap="round"/></svg>',
  verified: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 0l1.9 1.5 2.4-.4.9 2.3 2.2 1.1-.5 2.4L16 8l-1.1 2.1.5 2.4-2.2 1.1-.9 2.3-2.4-.4L8 16l-1.9-1.5-2.4.4-.9-2.3-2.2-1.1.5-2.4L0 8l1.1-2.1-.5-2.4 2.2-1.1.9-2.3 2.4.4z" fill="#1daa61"/><path d="M4.5 8.2l2.3 2.3 4.7-4.9" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  status: '<svg width="66" height="12" viewBox="0 0 66 12"><rect x="0" y="7" width="3" height="5" rx=".8" fill="#000"/><rect x="4.5" y="5" width="3" height="7" rx=".8" fill="#000"/><rect x="9" y="3" width="3" height="9" rx=".8" fill="#000"/><rect x="13.5" y="1" width="3" height="11" rx=".8" fill="#000"/><path d="M21 4.2a9 9 0 0 1 12 0M23.2 6.6a6 6 0 0 1 7.6 0M25.4 9a3 3 0 0 1 3.2 0" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round"/><rect x="39.5" y=".5" width="23" height="11" rx="3" fill="none" stroke="#000" stroke-opacity=".4"/><rect x="41" y="2" width="20" height="8" rx="1.8" fill="#000"/><path d="M64 4v4a2 2 0 0 0 0-4z" fill="#000" fill-opacity=".4"/></svg>',
};

export const WALLPAPER =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'><g fill='none' stroke='%23c9c1b4' stroke-opacity='.55' stroke-width='1.2' stroke-linecap='round'><circle cx='22' cy='24' r='5'/><path d='M60 14l4 8-8 2z'/><path d='M96 30c4-6 10-6 14 0'/><circle cx='34' cy='70' r='3'/><path d='M80 66h10M85 61v10'/><path d='M14 100c6-4 12 4 18 0'/><circle cx='102' cy='98' r='6'/><path d='M60 92l3 3-3 3-3-3z'/></g></svg>\")";

export function css(W, H) {
  return `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  .phone { width: ${W}px; height: ${H}px; overflow: hidden; position: relative; display: flex; flex-direction: column; background: #efeae2; }
  .top { background: #f6f6f6; border-bottom: 1px solid #d5d5d5; flex: 0 0 auto; }
  .statusbar { height: 54px; display: flex; align-items: flex-end; justify-content: space-between; padding: 0 30px 8px 36px; font-size: 16px; font-weight: 600; letter-spacing: -.2px; }
  .header { height: 58px; display: flex; align-items: center; padding: 0 12px 6px 8px; gap: 4px; }
  .header .back { display: flex; align-items: center; gap: 4px; color: #007aff; font-size: 17px; width: 46px; }
  .header .unread { background: #007aff; color: #fff; border-radius: 12px; font-size: 14px; font-weight: 600; padding: 1px 7px; }
  .avatar { width: 38px; height: 38px; border-radius: 50%; background: #6b8e83; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 15px; letter-spacing: .5px; overflow: hidden; flex: 0 0 auto; margin-right: 10px; }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .who { flex: 1 1 auto; min-width: 0; line-height: 1.15; }
  .who .name { font-size: 16.5px; font-weight: 600; color: #000; display: flex; align-items: center; gap: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .who .sub { font-size: 12px; color: #8a8a8e; margin-top: 2px; }
  .header .actions { display: flex; align-items: center; gap: 22px; padding-left: 8px; }
  .chat { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 10px 14px 6px; background: #efeae2 ${WALLPAPER}; overflow: hidden; }
  .chat.bottom { justify-content: flex-end; }
  .pill { align-self: center; background: rgba(255,255,255,.92); color: #6f6f73; font-size: 12.5px; padding: 5px 10px; border-radius: 8px; margin: 2px 0 10px; box-shadow: 0 1px .5px rgba(0,0,0,.08); text-align: center; }
  .pill.notice { background: #ffefc4; color: #5a4d2d; padding: 7px 14px; line-height: 1.3; max-width: 92%; }
  .msg { position: relative; max-width: 80%; padding: 6px 8px 8px 10px; border-radius: 12px; margin: 0 0 3px; font-size: 16px; line-height: 21px; color: #000; box-shadow: 0 1px .5px rgba(0,0,0,.13); white-space: pre-wrap; word-wrap: break-word; }
  .msg.in { align-self: flex-start; background: #fff; border-top-left-radius: 4px; }
  .msg.out { align-self: flex-end; background: #dcf8c6; border-top-right-radius: 4px; }
  .msg.first.in::before, .msg.first.out::before { content: ""; position: absolute; top: 0; width: 8px; height: 13px; }
  .msg.first.in::before { left: -8px; background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='13' viewBox='0 0 8 13'><path d='M8 0v13C4 12 1 6 0 3c1.5-1 4-2.5 8-3z' fill='%23fff'/></svg>"); }
  .msg.first.out::before { right: -8px; background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='13' viewBox='0 0 8 13'><path d='M0 0v13c4-1 7-7 8-10-1.5-1-4-2.5-8-3z' fill='%23dcf8c6'/></svg>"); }
  .msg.first { margin-top: 6px; }
  .msg .meta { position: absolute; right: 8px; bottom: 5px; font-size: 11.5px; color: #8c8c8c; display: inline-flex; align-items: center; gap: 3px; line-height: 12px; }
  .msg .spacer { display: inline-block; width: 56px; height: 1px; }
  .msg.out .spacer { width: 76px; }
  .msg a { color: #027eb5; text-decoration: underline; }
  .composer { flex: 0 0 auto; background: #f6f6f6; border-top: 1px solid #d5d5d5; padding: 6px 10px 0; }
  .composer .row { display: flex; align-items: center; gap: 10px; height: 44px; }
  .composer .input { flex: 1 1 auto; height: 36px; background: #fff; border: 1px solid #cfcfd2; border-radius: 18px; display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 14px; color: #8e8e93; font-size: 16px; }
  .composer .home { width: 134px; height: 5px; background: #000; border-radius: 3px; margin: 14px auto 8px; }
  `;
}

