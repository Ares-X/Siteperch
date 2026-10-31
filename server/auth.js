const encoder = new TextEncoder();
export const SESSION_SECONDS = 8 * 60 * 60;
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2,'0')).join('');
const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Malformed token');
  return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
}
function equal(a,b) {
  if (a.length !== b.length) return false;
  let difference = 0; for (let i=0;i<a.length;i++) difference |= a.charCodeAt(i)^b.charCodeAt(i); return difference === 0;
}
export function authConfigured(env) { return /^[a-f0-9]{64}$/.test(env.DASHBOARD_PASSWORD_SHA256 || '') && (env.DASHBOARD_SESSION_SECRET || '').length >= 32; }
function name(request) { return new URL(request.url).protocol === 'https:' ? '__Host-observatory' : 'observatory_dev'; }
async function signingKey(env) { return crypto.subtle.importKey('raw',encoder.encode(env.DASHBOARD_SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']); }
export async function passwordMatches(password, env) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) return false;
  const hash = hex(await crypto.subtle.digest('SHA-256',encoder.encode(password)));
  return equal(hash, env.DASHBOARD_PASSWORD_SHA256 || '');
}
export async function sessionCookie(request, env, now = new Date()) {
  const expiry = Math.floor(now.getTime()/1000) + SESSION_SECONDS;
  const payload = encode(encoder.encode(JSON.stringify({kind:'owner',exp:expiry,pv:env.DASHBOARD_PASSWORD_SHA256.slice(0,16)})));
  const signature = encode(await crypto.subtle.sign('HMAC', await signingKey(env),encoder.encode(payload)));
  return cookie(request, `${payload}.${signature}`, SESSION_SECONDS);
}
function cookie(request, value, seconds) { return `${name(request)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
export function clearSession(request) { return cookie(request,'',0); }
export async function authenticated(request, env, now = new Date()) {
  if (!authConfigured(env)) return false;
  const key = `${name(request)}=`;
  const value = (request.headers.get('cookie') || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(key))?.slice(key.length);
  if (!value || value.length > 1024) return false;
  try {
    const [payload,signature,...extra] = value.split('.'); if (extra.length || !payload || !signature) return false;
    if (!await crypto.subtle.verify('HMAC',await signingKey(env),decode(signature),encoder.encode(payload))) return false;
    const data=JSON.parse(new TextDecoder().decode(decode(payload)));
    const current=Math.floor(now.getTime()/1000);
    return data.kind==='owner' && Number.isSafeInteger(data.exp) && data.exp>current && data.exp<=current+SESSION_SECONDS && equal(data.pv || '',env.DASHBOARD_PASSWORD_SHA256.slice(0,16));
  } catch { return false; }
}
export function sameOrigin(request, env) {
  const actual = new URL(request.url).origin;
  let expected;
  try { expected = env.APP_ORIGIN ? new URL(env.APP_ORIGIN).origin : actual; } catch { return false; }
  return actual === expected && request.headers.get('origin') === expected;
}
