/* IC Leads — app.js
 * Toda la interfaz. Los datos vienen de la API (Apps Script) en un solo lote
 * ("bootstrap") y se escriben celda por celda con control de concurrencia.
 */
(function () {
'use strict';

const APP_VERSION = 'akt-crm-1.1.0';
const CFG = Object.assign({ API_URL: '', REFRESH_MS: 90000 }, window.AKT_CONFIG || {});
// El modo demo (datos ficticios) solo existe en el equipo de desarrollo: en el enlace real no se carga ni se ofrece.
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const DEMO = LOCAL && /[?&]demo=1\b/.test(location.search);

const ESTADOS = ['Nuevo', 'Contactado', 'Cotizado', 'Facturado', 'Perdido', 'Retenido'];
const MOTIVOS = ['precio', 'financiación negada', 'no aprobó financiación', 'sin capacidad de pago', 'compró en otro lado', 'compró en la competencia', 'cambió de modelo', 'cambió de decisión', 'no interesado', 'no contesta', 'atención', 'aún no decide', 'sin inventario', 'tiempo de entrega', 'no cumplió requisitos', 'cliente fuera de zona', 'solo cotizaba', 'dato errado', 'otro'];
const ETAPAS_MANUALES = ['Visitó', 'Crédito en estudio', 'Crédito aprobado', 'Crédito negado', 'Entregado'];
const TEMPS = ['caliente', 'tibio', 'frío'];

const S = {
  token: null, data: null, M: null, view: 'hoy', demoRole: 'jefe',
  f: { punto: '', asesor: '', origen: '', periodo: '30' },
  hoyAsesor: '', mes: '', segFiltro: { tipo: '', mes: '', sede: '', evaluado: '' },
  concTab: 'incons', cfgTab: 'sheet', lastLoad: null, timer: null, busy: false
};

// ── Utilidades ────────────────────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const digits = s => String(s ?? '').replace(/\D/g, '');
const tel10 = s => { const d = digits(s); return d.length >= 10 ? d.slice(-10) : ''; };
const si = v => ['si', 'true', '1', 'x', 'yes'].includes(norm(v));
const pad = n => String(n).padStart(2, '0');
const num = v => { if (v === '' || v === null || v === undefined || !/\d/.test(String(v))) return null; const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
const pct = (a, b) => b ? Math.round(a / b * 100) : null;
const fmtPct = v => v === null || v === undefined ? '—' : v + '%';
const money = v => v === null || v === undefined ? '—' : '$' + Math.round(v).toLocaleString('es-CO');
const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const uniq = a => Array.from(new Set(a.filter(Boolean)));
function sedeCanon(s) {
  const n = norm(s);
  if (n.includes('itag')) return 'Itagüí';
  if (n.includes('colores') || n.includes('medellin')) return 'Los Colores'; // bodega "MOTOS MEDELLIN" en Síntesis
  return String(s || '').trim();
}
function rolDeCargo(c) {
  const n = norm(c);
  if (n.includes('jefe')) return 'jefe';
  if (n.includes('admin')) return 'admin';
  if (n.includes('asesor')) return 'asesor';
  return '';
}
// La columna del Sheet se llama "CEDULA " (con espacio); se busca sin importar mayúsculas.
function cedulaDe(p) { for (const k in p) if (norm(k) === 'cedula') return digits(p[k]); return ''; }
function canonTemp(v) {
  const n = norm(v);
  if (n.startsWith('cali')) return 'caliente';
  if (n.startsWith('tib')) return 'tibio';
  if (n.startsWith('fri')) return 'frío';
  return '';
}

// ── Fechas en hora de Colombia (UTC−5, sin horario de verano) ─────────────
const OFF = 5 * 3600e3;
const bog = (y, mo, d, h = 0, mi = 0, se = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, se) + OFF);
function bparts(dt) { const x = new Date(dt.getTime() - OFF); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), dow: x.getUTCDay(), h: x.getUTCHours(), mi: x.getUTCMinutes() }; }
const ymd = dt => { const p = bparts(dt); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const ym = dt => { const p = bparts(dt); return `${p.y}-${pad(p.m)}`; };
function parseFecha(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  let m;
  if (/(z|[+-]\d\d:?\d\d)$/i.test(s) && !isNaN(Date.parse(s))) return new Date(s);
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/))) return bog(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?)?/i))) {
    let h = +(m[4] || 0); const ap = (m[7] || '').toLowerCase();
    if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0;
    return bog(+m[3], +m[2], +m[1], h, +(m[5] || 0), +(m[6] || 0));
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}
function fmtFecha(dt, conHora = true) {
  if (!dt) return '—';
  const p = bparts(dt);
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  let s = `${p.d} ${meses[p.m - 1]}`;
  if (p.y !== bparts(new Date()).y) s += ' ' + p.y;
  if (conHora) { const h12 = p.h % 12 || 12; s += ` ${h12}:${pad(p.mi)} ${p.h < 12 ? 'a. m.' : 'p. m.'}`; }
  return s;
}
const MESES_L = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fmtMes = k => { if (!k) return '—'; const [y, m] = k.split('-'); return cap(MESES_L[+m - 1]) + ' ' + y; };
function mesKey(v) {
  if (!v) return '';
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})$/))) return `${m[1]}-${pad(m[2])}`;
  if ((m = s.match(/^(\d{1,2})[-/](\d{4})$/))) return `${m[2]}-${pad(m[1])}`;
  const d = parseFecha(s); if (d) return ym(d);
  const i = MESES_L.findIndex(x => norm(s).startsWith(x.slice(0, 3)));
  const y = (s.match(/\d{4}/) || [])[0];
  if (i >= 0 && y) return `${y}-${pad(i + 1)}`;
  if (i >= 0) { // «OCTUBRE» sin año: se toma el año en que ese mes queda más cerca de hoy (en octubre, «ENERO» es el de enero que viene)
    const b = bparts(new Date()), pos = b.y * 12 + b.m - 1;
    const yr = [b.y - 1, b.y, b.y + 1].sort((a, c) => Math.abs(a * 12 + i - pos) - Math.abs(c * 12 + i - pos))[0];
    return `${yr}-${pad(i + 1)}`;
  }
  return '';
}

// Festivos de Colombia (Ley Emiliani + Semana Santa)
const _fest = {};
function pascua(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, mes - 1, dia));
}
function festivos(y) {
  if (_fest[y]) return _fest[y];
  const set = new Set();
  const D = (m, d) => new Date(Date.UTC(y, m - 1, d));
  const k = dt => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  const lunes = dt => { const w = dt.getUTCDay(); return w === 1 ? dt : new Date(dt.getTime() + ((8 - w) % 7) * 864e5); };
  [[1, 1], [5, 1], [7, 20], [8, 7], [12, 8], [12, 25]].forEach(([m, d]) => set.add(k(D(m, d))));
  [[1, 6], [3, 19], [6, 29], [8, 15], [10, 12], [11, 1], [11, 11]].forEach(([m, d]) => set.add(k(lunes(D(m, d)))));
  const e = pascua(y), mas = n => new Date(e.getTime() + n * 864e5);
  [mas(-3), mas(-2)].forEach(x => set.add(k(x)));
  [mas(39), mas(60), mas(68)].forEach(x => set.add(k(lunes(x))));
  return (_fest[y] = set);
}
// Horario hábil: L–V 9:30–18:00, sáb 9:30–15:00, dom y festivos cerrado.
function ventana(y, m, d, dow) {
  if (dow === 0 || festivos(y).has(`${y}-${pad(m)}-${pad(d)}`)) return null;
  return [bog(y, m, d, 9, 30).getTime(), (dow === 6 ? bog(y, m, d, 15, 0) : bog(y, m, d, 18, 0)).getTime()];
}
function horasHabiles(a, b) {
  if (!a || !b || b <= a) return 0;
  const A = a.getTime(), B = b.getTime();
  const pa = bparts(a), pb = bparts(b);
  let day = Date.UTC(pa.y, pa.m - 1, pa.d); const end = Date.UTC(pb.y, pb.m - 1, pb.d);
  let ms = 0, guard = 0;
  while (day <= end && guard++ < 400) {
    const dt = new Date(day);
    const w = ventana(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), dt.getUTCDay());
    if (w) { const s = Math.max(w[0], A), e = Math.min(w[1], B); if (e > s) ms += e - s; }
    day += 864e5;
  }
  return ms / 36e5;
}
function fmtHoras(h) {
  if (h === null || h === undefined) return '—';
  if (h < 1) return Math.round(h * 60) + ' min';
  if (h < 10) return h.toFixed(1).replace('.', ',') + ' h';
  return Math.round(h) + ' h';
}

// ── API ───────────────────────────────────────────────────────────────────
async function api(action, payload = {}) {
  if (DEMO) return window.AKT_DEMO.handle(action, payload, S.demoRole);
  const res = await fetch(CFG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita preflight CORS en Apps Script
    body: JSON.stringify(Object.assign({ action, token: S.token }, payload))
  });
  if (!res.ok) throw new Error('El servidor respondió ' + res.status);
  const j = await res.json();
  if (!j.ok && !j.conflict) { const e = new Error(j.error || 'Error desconocido'); e.code = j.code; throw e; }
  return j;
}

// ── Sesión ────────────────────────────────────────────────────────────────
// La sesión (token firmado por la API, válido 12 h) se guarda en este dispositivo.
// La contraseña nunca se guarda: solo viaja una vez, al entrar.
function store(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function tokenVigente(t) {
  try { const p = JSON.parse(atob(t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))); return p.exp > Date.now() + 60e3; } catch (e) { return false; }
}

function mostrarLogin(msg) {
  $('#app').hidden = true; $('#login').hidden = false;
  const box = $('#login-msg');
  box.hidden = !msg; box.textContent = msg || '';
  $('#login-ver').textContent = 'Versión ' + (window.AKT_VERSION || '?');
  $('#demo-link').hidden = !LOCAL || DEMO;
  if (DEMO) return;
  if (!CFG.API_URL) {
    $('#login-form').hidden = true;
    box.hidden = false;
    box.textContent = 'Falta configurar API_URL en config.js (la URL /exec del Apps Script, ver backend/README.md).';
    return;
  }
  $('#login-form').hidden = false;
  setTimeout(() => $('#login-ced').focus(), 50);
}

async function entrar(ev) {
  ev.preventDefault();
  const btn = $('#login-btn'), box = $('#login-msg');
  // Usuario = la parte del correo antes del @ (si escribe el correo completo, se corta solo). Una cédula solo vale mientras el acceso esté en modo mixto.
  const usuario = $('#login-ced').value.trim().toLowerCase().split('@')[0].replace(/\s+/g, ''), password = $('#login-pass').value;
  if (!usuario || !password) { box.hidden = false; box.textContent = 'Escribe tu usuario (tu correo antes del @) y la contraseña.'; return; }
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2 spin"></i> Entrando…'; box.hidden = true;
  try {
    const r = await api('login', { usuario, password });
    S.token = r.token; store('akt_ses', r.token);
    $('#login-pass').value = '';
    arrancar();
  } catch (e) {
    box.hidden = false; box.textContent = e.message;
  } finally { btn.disabled = false; btn.innerHTML = '<i class="ti ti-login-2"></i> Entrar'; }
}

function salir(msg) {
  S.token = null; store('akt_ses', null); S.bienvenidaVista = false;
  const w = $('#welcome'); if (w) w.hidden = true;
  clearInterval(S.timer);
  mostrarLogin(msg);
}

// ── Versión nueva: la app abierta se entera sola (el navegador guarda index.html hasta 10 min) y ofrece actualizar ──
async function buscarVersionNueva() {
  try {
    const t = await fetch('index.html?_=' + Date.now(), { cache: 'no-store' }).then(r => r.text());
    const v = (t.match(/AKT_VERSION = '([^']+)'/) || [])[1];
    if (!v || v === window.AKT_VERSION || document.getElementById('nueva-version')) return;
    const b = document.createElement('div'); b.id = 'nueva-version';
    b.style.cssText = 'position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:9999;background:#0b2e6e;color:#fff;padding:10px 16px;border-radius:14px;box-shadow:0 10px 30px -8px rgba(0,0,0,.5);display:flex;gap:12px;align-items:center;font-size:.9rem';
    b.innerHTML = `<span>🚀 Hay una versión nueva (v${v})</span><button class="btn btn-sm btn-primary" id="nv-btn">Actualizar ahora</button>`;
    document.body.appendChild(b);
    $('#nv-btn').onclick = () => { location.href = location.pathname + '?v=' + v + (DEMO ? '&demo=1' : ''); };
  } catch (e) { /* sin red: se reintenta */ }
}
setTimeout(buscarVersionNueva, 4000); setInterval(buscarVersionNueva, 5 * 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) buscarVersionNueva(); });

async function arrancar() {
  $('#login').hidden = true; $('#app').hidden = false;
  $('#view').innerHTML = '<div class="loading"><div><i class="ti ti-loader-2 spin"></i> Cargando leads…</div></div>';
  if (DEMO) {
    $('#demo-badge').hidden = false;
    document.body.classList.add('demo');
    const sel = $('#demo-role'); sel.hidden = false;
    sel.innerHTML = window.AKT_DEMO.roles.map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join('');
    sel.value = S.demoRole;
  }
  const ok = await cargar();
  if (!ok) return;
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden && $('#sheet').hidden) cargar(true); }, Math.max(60000, CFG.REFRESH_MS));
}

async function cargar(silencioso) {
  if (S.busy) return false;
  S.busy = true;
  $('#btn-refresh i').classList.add('spin');
  try {
    if (!DEMO && S.token && !tokenVigente(S.token)) { salir('Tu sesión venció. Vuelve a entrar.'); return false; }
    S.data = await api('bootstrap');
    construirModelo();
    S.lastLoad = new Date();
    $('#sync-state').textContent = 'Actualizado ' + fmtFecha(S.lastLoad).split(' ').slice(2).join(' ');
    $('#tb-sub').textContent = `${S.data.user.nombre} · ${({ asesor: 'Asesor', admin: 'Administrador', jefe: 'Jefe Comercial' })[S.data.user.rol]}${S.data.user.sede ? ' · ' + S.data.user.sede : ''}`;
    $('#tb-ver').textContent = `v${window.AKT_VERSION || '?'}${S.data.version ? ' · API ' + S.data.version : ''}`;
    if (!S.bandejaIni) { S.bandejaIni = true; cargarBandeja(); }
    const vistas = vistasDeRol();
    if (!S._home) { S._home = 1; S.view = homeDeRol(); }
    if (!vistas.some(v => v.id === S.view)) S.view = vistas[0].id;
    renderNav(); render();
    // Ventana grande de bienvenida: una vez por ingreso (no en las actualizaciones automáticas)
    if (!S.bienvenidaVista) { S.bienvenidaVista = true; try { mostrarBienvenida(); } catch (e2) { console.error(e2); } }
    return true;
  } catch (e) {
    if (['AUTH', 'NOUSER'].includes(e.code)) { salir(e.message); return false; }
    if (!silencioso || !S.data) {
      $('#view').innerHTML = `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div><b>No se pudieron cargar los datos.</b><br>${esc(e.message)}${e.code === 'CONFIG' ? '<br>Revisa las Propiedades del script (ver backend/README.md).' : ''}</div></div>`;
    } else toast('No se pudo actualizar: ' + e.message, 'bad');
    return false;
  } finally {
    S.busy = false;
    $('#btn-refresh i').classList.remove('spin');
  }
}

// ── Modelo ────────────────────────────────────────────────────────────────
function construirModelo() {
  const d = S.data, now = new Date();
  const c = {}; (d.config || []).forEach(r => { c[r.clave] = r.valor; });
  const n = (k, def) => { const v = num(c[k]); return v === null ? def : v; };
  const cfg = {
    raw: c,
    sla_preventiva_h: n('sla_preventiva_h', 1), sla_vencida_h: n('sla_vencida_h', 3), sin_cotizar_h: n('sin_cotizar_h', 20),
    cotizado_sin_avance_dias: n('cotizado_sin_avance_dias', null), seguimiento_frecuencia_dias: n('seguimiento_frecuencia_dias', null)
  };

  const gBy = {}; (d.gestion || []).forEach(g => { gBy[String(g.id_lead)] = g; });
  const bitContacto = {};
  (d.bitacora || []).forEach(b => {
    if (b.hoja === 'Gestion_Asesor' && b.campo === 'contactado' && norm(b.valor_nuevo) === 'si') {
      const f = parseFecha(b.fecha_hora); const k = String(b.llave);
      if (f && (!bitContacto[k] || f < bitContacto[k])) bitContacto[k] = f;
    }
  });
  const cotUsadas = new Set(), facUsadas = new Set();
  const cotTel = {}, cotIdc = {};
  (d.cotizaciones || []).forEach((q, i) => {
    q._i = i;
    const t = tel10(q.telefono_lead); if (t) (cotTel[t] = cotTel[t] || []).push(q);
    if (q.id_contacto) (cotIdc[String(q.id_contacto)] = cotIdc[String(q.id_contacto)] || []).push(q);
  });
  const facLead = {};
  (d.facturas || []).forEach((f, i) => { f._i = i; if (f.id_lead) (facLead[String(f.id_lead)] = facLead[String(f.id_lead)] || []).push(f); });
  const alertasLead = {};
  (d.alertas || []).forEach(a => {
    [a.id_lead, a.id_contacto].filter(Boolean).forEach(k => { (alertasLead[String(k)] = alertasLead[String(k)] || []).push(a); });
  });

  const pendContSet = new Set((d.contacto_pendiente || []).map(String));
  const leads = (d.leads || []).map(l => {
    const id = String(l.id_lead || l.id_contacto || '');
    const g = l.id_lead ? gBy[String(l.id_lead)] || null : null;
    const tels = uniq([tel10(l.telefono_whatsapp), tel10(l.telefono_contacto)]);
    const cot = uniq([].concat(...tels.map(t => cotTel[t] || []), l.id_contacto ? cotIdc[String(l.id_contacto)] || [] : []));
    const fac = l.id_lead ? facLead[String(l.id_lead)] || [] : [];
    cot.forEach(q => cotUsadas.add(q._i)); fac.forEach(f => facUsadas.add(f._i));
    const asign = parseFecha(l.fecha_asignacion) || parseFecha(g && g.fecha_hora_registro) || parseFecha(l.fecha_primer_contacto);
    const contactadoEn = parseFecha(g && g.fecha_contactado) || bitContacto[id] || null;
    const contactado = si(g && g.contactado), cotizado = si(g && g.cotizado);
    const res = norm((g && g.resultado) || l.resultado_venta);
    let estado = 'Nuevo';
    const ec = norm(l.estado_crm);
    if (ec) estado = ESTADOS.find(e => ec.startsWith(norm(e).slice(0, 5))) || (ec.startsWith('ganad') ? 'Facturado' : 'Nuevo');
    else if (/^(ganad|factur|vendid|por fac)/.test(res)) estado = 'Facturado';
    else if (res.startsWith('perd')) estado = 'Perdido';
    else if (res.startsWith('reten')) estado = 'Retenido';
    else if (cotizado) estado = 'Cotizado';
    else if (contactado) estado = 'Contactado';

    // Cerrado ganado: la venta ya aparece en Síntesis (factura cruzada por celular) → el lead pasa solo a ganado.
    const cerrado = fac.length > 0;
    if (cerrado) estado = 'Facturado';
    // «Otra ciudad»: escribió desde un municipio fuera de la cobertura (Antioquia/puntos); el bot le avisó y no se le asigna asesor.
    if (!cerrado && norm(l.etapa) === 'otra_ciudad' && !['Facturado', 'Perdido', 'Retenido'].includes(estado)) estado = 'Otra ciudad';

    const incons = [];
    if ((estado === 'Cotizado' || (estado === 'Facturado' && cotizado)) && !cot.length) incons.push('Marcado cotizado sin cotización en el CRM');
    if (estado === 'Facturado' && !fac.length) incons.push('Marcado vendido sin factura (pendiente de facturar)');
    if (ec.includes('inconsist') && !incons.length) incons.push('Inconsistencia reportada por n8n');

    const tel = tel10(l.telefono_whatsapp) || tel10(l.telefono_contacto);
    const cita = parseFecha(l.cita_dia ? (String(l.cita_dia).slice(0, 10) + (l.cita_hora ? ' ' + horaTxt(l.cita_hora) : '')) : null);
    const hAsign = asign ? horasHabiles(asign, now) : null;
    const hPrimera = asign && contactadoEn ? horasHabiles(asign, contactadoEn) : null;
    const ultimaAct = parseFecha(g && g.fecha_ultima_actualizacion);

    let sla = null;
    if (estado === 'Nuevo' && hAsign !== null) sla = hAsign >= cfg.sla_vencida_h ? 'bad' : hAsign >= cfg.sla_preventiva_h ? 'warn' : 'ok';
    const sinCotizar = estado === 'Contactado' && hAsign !== null && hAsign >= cfg.sin_cotizar_h;
    const diasSinAvance = ultimaAct ? (now - ultimaAct) / 864e5 : null;
    const cotSinAvance = estado === 'Cotizado' && cfg.cotizado_sin_avance_dias !== null && diasSinAvance !== null && diasSinAvance >= cfg.cotizado_sin_avance_dias;
    const alertas = uniq([].concat(alertasLead[String(l.id_lead)] || [], l.id_contacto ? alertasLead[String(l.id_contacto)] || [] : []));

    return {
      id, raw: l, g, estado, cerrado, incons, cot, fac, alertas, tel, asign, contactadoEn, hAsign, hPrimera, ultimaAct,
      contactado, cotizado, resultado: res, pendCont: pendContSet.has(String(l.id_lead || '')), motivo: (g && g.motivo_perdida) || '',
      nombre: String(l.nombre_completo || l.username_whatsapp || '').trim() || 'Sin nombre',
      usuario: l.username_whatsapp || '', sede: sedeCanon(l.punto_asignado), asesor: String(l.nombre_asesor || '').trim(),
      origen: String(l.origen || '').trim() || 'Sin origen', anuncio: String(l.anuncio_origen || '').trim(),
      temp: canonTemp(l.etiqueta_asesor), tempIA: canonTemp(l.etiqueta), cita,
      citaHoy: cita && ymd(cita) === ymd(now), sla, sinCotizar, cotSinAvance, diasSinAvance,
      aTiempo: hPrimera !== null ? hPrimera <= cfg.sla_preventiva_h : null
    };
  });

  const byId = {}; leads.forEach(l => { byId[l.id] = l; });
  const personas = (d.personal || []).map(p => Object.assign({}, p, { rolApp: rolDeCargo(p.rol || p.cargo), sedeCanon: p.sedeCanon || sedeCanon(p.sede) }));
  S.M = {
    cfg, leads, byId, personas,
    // Asesores comerciales: excluye posventa (recibe = posventa) y personas inactivas.
    // El administrador de sede es un asesor más (mismos leads, chats, metas y comisiones) con la responsabilidad adicional del punto.
    asesores: personas.filter(p => (p.rolApp === 'admin' || (p.rolApp === 'asesor' && norm(p.recibe) !== 'posventa')) && (!p.activo || norm(p.activo).startsWith('si'))),
    cotHuerfanas: (d.cotizaciones || []).filter(q => !cotUsadas.has(q._i)),
    facSinOrigen: (d.facturas || []).filter(f => !f.id_lead || !leads.some(l => String(l.raw.id_lead) === String(f.id_lead))),
    alertasAbiertas: (d.alertas || []).filter(a => !si(a.atendida) && !a.fecha_atendida)
  };
}
function horaTxt(h) {
  const s = String(h);
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) {
    let hh = +m[1];
    if (/p\.?\s*m/i.test(s) && hh < 12) hh += 12;
    if (/a\.?\s*m/i.test(s) && hh === 12) hh = 0;
    return `${pad(hh)}:${m[2]}`;
  }
  return '';
}

// ── Pantallas por cargo: Jefe (Centro de Inteligencia) · Administrador (Mi Punto) · Asesor (Mi Día) ──
const PANEL_VIEWS = ['inteligencia', 'punto', 'dia', 'equipo', 'miscot', 'misventas', 'entregas', 'citas'];
const SEM = { verde: '🟢', ambar: '🟠', rojo: '🔴', gris: '⚪' };
function cargarPanel() {
  if (S.panBusy) return; S.panBusy = true;
  api('panel', { sede: S.panSede || '', dias: S.panDias || 30 }).then(r => { S.pan = r; S.panErr = ''; S.panT = Date.now(); }).catch(e => { S.panErr = e.message; S.panT = Date.now(); })
    .finally(() => { S.panBusy = false; if (PANEL_VIEWS.includes(S.view)) render(); });
}
setInterval(() => { try { if (S && S.data && PANEL_VIEWS.includes(S.view) && !document.hidden && $('#sheet').hidden) cargarPanel(); } catch (e) { /* sin panel */ } }, 60e3);
function panelListo() {
  if (!S.pan || Date.now() - (S.panT || 0) > 90e3) cargarPanel();
  if (S.pan) return null;
  return S.panErr ? `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div>${esc(S.panErr)}</div></div>` : '<div class="loading"><div><i class="ti ti-loader-2 spin"></i> Preparando tu panel…</div></div>';
}
function vControlTab(t) { if (S._vistaPrev !== S.view) S.ctlTab = t; return vControl(); }
const mM = v => v >= 1e6 ? '$' + Math.round(v / 1e6) + 'M' : money(v);
const colEstado = e => ({ verde: '#22c55e', ambar: '#f59e0b', rojo: '#ef4444', gris: '#94a3b8' })[e] || '#22c55e';
function hero(cls, icono, titulo, sub) { return `<div class="hero ${cls}"><div class="hero-ic"><i class="ti ${icono}"></i></div><div><h2>${titulo}</h2><p>${sub}</p></div><span class="tiny" style="margin-left:auto;opacity:.8">🔄 ${S.panT ? new Date(S.panT).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>`; }
function iaCard(cls, titulo, lineas, btn) { return `<div class="ia-card ${cls}"><div class="ia-h"><i class="ti ti-robot"></i><b>${esc(titulo)}</b></div><ul>${lineas.map(x => `<li>${esc(x)}</li>`).join('') || '<li>Todo en orden por ahora ✅</li>'}</ul>${btn || ''}</div>`; }
function scoreChip(s) { return `<span class="sc ${s >= 80 ? 'hi' : s >= 60 ? 'md' : 'lo'}">${s}</span>`; }
function accionBtn(l) {
  const t = digits(l.telefono || ''), tel = t.length === 12 ? t : (t.length === 10 ? '57' + t : '');
  if (l.accion === 'Llamar' && tel) return `<a class="btn btn-sm btn-ok" href="tel:+${tel}"><i class="ti ti-phone"></i> Llamar</a>`;
  if (l.accion === 'Gestionar') return `<button class="btn btn-sm btn-dark" data-act="abrir" data-id="${esc(l.id)}">Gestionar</button>`;
  return `<button class="btn btn-sm" data-act="ir-chat" data-id="${esc(l.id)}"><i class="ti ti-brand-whatsapp"></i> ${esc(l.accion || 'Ver')}</button>`;
}
function tablaOport(rows, conAsesor) {
  if (!rows.length) return '<p class="small muted">Sin oportunidades abiertas.</p>';
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Cliente</th><th>Moto</th>${conAsesor ? '<th>Asesor</th>' : ''}<th class="r">Score IA</th><th>Estado</th><th>Acción</th></tr></thead><tbody>${rows.map(l => `<tr><td><b data-act="abrir" data-id="${esc(l.id)}" style="cursor:pointer">${esc(l.nombre)}</b></td><td>${esc(l.producto || '—')}</td>${conAsesor ? `<td>${esc(l.asesor || '')}${l.sede ? ` <span class="tiny muted">· ${esc(l.sede)}</span>` : ''}</td>` : ''}<td class="r">${scoreChip(l.score)}</td><td><span class="pill">${esc(l.fase || l.estado)}</span>${l.sinSoporte ? ' <span class="pill pill-warn" title="Marcado cotizado, pero la cotización no aparece en el CRM">sin cotización en el CRM</span>' : ''}</td><td>${accionBtn(l)}</td></tr>`).join('')}</tbody></table></div>`;
}
const pctDe = (a, b) => b ? Math.round(a * 100 / b) : null;
const txtPct = v => v === null || v === undefined ? '—' : v + ' %';
const txtT = h => h === null || h === undefined ? '—' : (h < 1 ? Math.round(h * 60) + ' min' : (Math.round(h * 10) / 10) + ' h');
/** Grupo de origen de un lead (igual que el servidor): Pauta redes sociales, Referido, Orgánico, Cotizador web u Otro. */
function canalLead(l) {
  const r = l.raw || l, o = norm(r.origen);
  if (String(r.ctwa_clid || '').trim() || /pauta|anuncio|facebook|instagram|meta ads/.test(o)) return 'Pauta redes sociales';
  if (String(r.referido_por || '').trim() || /^referid/.test(o)) return 'Referido';
  if (!o || /^organ/.test(o)) return 'Orgánico';
  if (/cotizador|web|formulario/.test(o)) return 'Cotizador web';
  return 'Otro';
}
/** Tabla de asesores centrada en gestión de leads: contacto, tiempos, cotización con soporte en el CRM, ventas cruzadas con Síntesis y reasignaciones. */
function tablaAsesores(ctl, opts) {
  opts = opts || {};
  const R = ((ctl.reasignaciones || {}).porAsesor) || [], reas = n => R.find(x => mismaPersona(x.asesor, n)) || { cedidos: 0, recibidos: 0 };
  let rows = (ctl.asesores || []).filter(a => a.k && a.k !== 'Sin asesor' && a.leads > 0);
  const sinAs = (ctl.asesores || []).find(a => a.k === 'Sin asesor');
  if (!rows.length && !sinAs) return '<p class="small muted">Aún no hay leads asignados en este período.</p>';
  const fila = a => { const rr = reas(a.k), p2 = pctDe(a.en2h || 0, a.conTResp || 0); return `<tr${opts.click ? ` data-act="eq-sel" data-id="${esc(a.k)}" style="cursor:pointer"` : ''}><td><b>${esc(a.k)}</b></td><td class="r">${a.leads}</td><td class="r">${a.sinContacto ? `<span class="pill pill-bad">${a.sinContacto}</span>` : 0}</td><td class="r">${txtT(a.tResp)}</td><td class="r">${txtPct(p2)}</td><td class="r">${a.cotizaciones}</td><td class="r">${a.sinSoporte ? `<span class="pill pill-warn">${a.sinSoporte}</span>` : 0}</td><td class="r"><b>${a.ventas}</b></td><td class="r">${rr.cedidos}</td><td class="r">${rr.recibidos}</td></tr>`; };
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Asesor</th><th class="r">Leads</th><th class="r">Sin contacto</th><th class="r" title="Mediana entre que entró el lead y el primer contacto">1er contacto</th><th class="r" title="Leads contactados dentro de las 2 primeras horas">≤ 2 h</th><th class="r">Cotizados</th><th class="r" title="Marcados cotizados sin cotización en el CRM">Sin cotización CRM</th><th class="r" title="Cruzadas con ventas de Síntesis">Vendidos</th><th class="r" title="Leads que perdió por reasignación">Cedidos</th><th class="r" title="Leads que recibió por reasignación">Recibidos</th></tr></thead><tbody>${rows.map(fila).join('')}${sinAs ? `<tr><td><b>Sin asesor</b></td><td class="r">${sinAs.leads}</td><td class="r"><span class="pill pill-bad">${sinAs.sinContacto}</span></td><td class="r" colspan="7"><span class="small muted">Asígnalos cuanto antes</span></td></tr>` : ''}</tbody></table></div>`;
}
/** Tabla por origen: pauta en redes, referidos, orgánico y cotizador web. */
function tablaOrigen(ctl) {
  const G = (ctl.grupos || {}).canal || []; if (!G.length) return '<p class="small muted">Sin leads en el período.</p>';
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Origen</th><th class="r">Leads</th><th class="r">Contactados</th><th class="r">1er contacto</th><th class="r">Cotizados</th><th class="r">Vendidos</th><th class="r">Conversión</th><th class="r">Reasignados</th></tr></thead><tbody>${G.map(g => `<tr><td><b>${esc(g.k)}</b></td><td class="r">${g.leads}</td><td class="r">${g.contactados}</td><td class="r">${txtT(g.tResp)}</td><td class="r">${g.cotizaciones}${g.sinSoporte ? ` <span class="pill pill-warn" title="sin cotización en el CRM">${g.sinSoporte}</span>` : ''}</td><td class="r"><b>${g.ventas}</b></td><td class="r">${txtPct(g.conv)}</td><td class="r">${g.reasignados || 0}</td></tr>`).join('')}</tbody></table></div>`;
}
/** Tarjetas de lo que se mide: contacto, tiempos, cotización con soporte y reasignación. Cada una abre la lista de leads. */
function kpisGestion(ctl) {
  const k = ctl.kpis || {}, R = ctl.reasignaciones || { total: 0 }, conT = k.conTiempoContacto || 0, o = k.porOrigen || {};
  const orig = ['Pauta redes sociales', 'Referido', 'Orgánico', 'Cotizador web', 'Otro'].filter(x => o[x]).map(x => `${o[x]} ${x === 'Pauta redes sociales' ? 'pauta' : x.toLowerCase()}`).join(' · ') || 'sin leads en el período';
  return `<div class="grid g-kpi">
    ${kpiP('leads', '📥 Leads recibidos', k.recibidos || 0, orig)}
    ${kpiP('sincontacto', '⏳ Sin contactar', k.sinContacto || 0, `${k.nuevos || 0} nuevos · ${k.contactados || 0} ya contactados`, k.sinContacto ? 'bad' : 'ok')}
    ${kpi('⚡ Contacto en 15 min', txtPct(pctDe(k.contactoEn15min || 0, conT)), `${k.contactoEn15min || 0} de ${conT} contactados`)}
    ${kpi('⏱️ Contacto en 2 h', txtPct(pctDe(k.contactoEn2h || 0, conT)), `1er contacto (mediana): ${txtT(k.mediana1raRespuestaH)}`, conT && pctDe(k.contactoEn2h || 0, conT) < 70 ? 'warn' : '')}
    ${kpiP('cotizaciones', '📝 Cotizados', k.cotizaciones || 0, `${(k.cotizaciones || 0) - (k.cotizadosSinSoporte || 0)} con cotización en el CRM`)}
    ${kpiP('sinsoporte', '⚠️ Cotizado sin soporte', k.cotizadosSinSoporte || 0, `${k.cotizadosSinSoporteVencidos || 0} fuera de plazo`, k.cotizadosSinSoporte ? 'warn' : 'ok')}
    ${kpiP('reasignados', '🔁 Reasignados', k.reasignados || 0, `${R.total || 0} reasignaciones en el período`)}
    ${kpiP('ventas', '💰 Vendidos (Síntesis)', k.ventas || 0, `${txtPct(k.conversion)} de los leads`, k.ventas ? 'ok' : '')}</div>`;
}
function listaReasignaciones(ctl) {
  const R = (ctl.reasignaciones || {}).recientes || []; if (!R.length) return '<p class="small muted">Sin reasignaciones en el período.</p>';
  return R.slice(0, 8).map(x => `<div class="small" style="margin:6px 0">🔁 <b data-act="abrir" data-id="${esc(x.id_lead)}" style="cursor:pointer">${esc(x.nombre || 'Lead')}</b> · ${esc(x.de || '—')} → <b>${esc(x.a || '—')}</b> <span class="tiny muted">· ${esc(String(x.fecha).slice(0, 16))} · ${esc(x.motivo)}</span></div>`).join('');
}
function listaAlertas(ctl) {
  const A = (ctl.alertas || []).slice(0, 6); if (!A.length) return '<p class="small muted">Sin alertas recientes ✅</p>';
  return A.map(a => `<div class="small" style="margin:6px 0"><span class="pill ${a.nivel === 'alta' ? 'pill-bad' : 'pill-warn'}">${esc(String(a.tipo || '').replace(/_/g, ' '))}</span> ${esc(String(a.mensaje || '').split('\n')[0].slice(0, 120))}</div>`).join('');
}
function kpiRow(items) { return `<div class="grid g-kpi">${items.map(i => kpi(i[0], i[1], i[2], i[3])).join('')}</div>`; }

/** Inteligencia comercial (datos de Supabase): pauta → venta, prioridad de leads, cotizaciones por reactivar y rendimiento de asesores. */
function cargarIC() {
  if (S.icBusy) return; S.icBusy = true;
  api('inteligenciaIC').then(r => { S.ic = r; S.icErr = ''; S.icT = Date.now(); }).catch(e => { S.icErr = e.message; S.icT = Date.now(); })
    .finally(() => { S.icBusy = false; if (S.view === 'icventas') render(); });
}
function vICVentas() {
  if ((!S.ic && Date.now() - (S.icT || 0) > 20e3) || (S.ic && Date.now() - (S.icT || 0) > 120e3)) cargarIC();
  if (!S.ic) return S.icErr ? `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div>${esc(S.icErr)}</div></div>` : '<div class="loading"><div><i class="ti ti-loader-2 spin"></i> Leyendo la inteligencia comercial…</div></div>';
  const r = S.ic, P = r.pauta || [], Q = r.prioridad || [], R = r.reactivar || [], A = r.asesores || [];
  const sum = k => P.reduce((s, x) => s + (Number(x[k]) || 0), 0), L = sum('leads'), V = sum('ventas'), CZ = sum('cotizados');
  const pct = (a, b) => b ? (a * 100 / b).toFixed(1).replace('.', ',') + '%' : '—';
  const wa = t => { const d = String(t || '').replace(/\D/g, ''); return d ? `https://wa.me/${d.length === 10 ? '57' + d : d}` : ''; };
  const mejor = P.filter(x => x.ventas > 0).sort((a, b) => b.conversion_pct - a.conversion_pct)[0];
  const sinVenta = P.filter(x => x.leads >= 5 && !x.ventas).sort((a, b) => b.leads - a.leads)[0];
  const ia = [];
  if (mejor) ia.push(`✅ «${mejor.anuncio}» es el que mejor convierte: ${pct(mejor.ventas, mejor.leads)} (${mejor.ventas} ventas de ${mejor.leads} leads).`);
  if (sinVenta) ia.push(`⚠️ «${sinVenta.anuncio}» trajo ${sinVenta.leads} leads y ninguna venta: revisa el mensaje o el público.`);
  const calientes = Q.filter(x => /caliente/i.test(x.temperatura || '') && Number(x.minutos_sin_respuesta) > 15).length;
  if (calientes) ia.push(`🔥 ${calientes} lead${calientes === 1 ? '' : 's'} caliente${calientes === 1 ? '' : 's'} lleva${calientes === 1 ? '' : 'n'} más de 15 min sin respuesta.`);
  if (R.length) ia.push(`📲 ${R.length} cotizaci${R.length === 1 ? 'ón' : 'ones'} sin venta para reactivar por WhatsApp.`);
  if (P.length === 1 && /sin anuncio/i.test(P[0].anuncio)) ia.push('🔗 Aún no hay leads con anuncio de origen. Se llenan solos cuando un cliente escribe desde un anuncio de Facebook o Instagram.');
  const tabla = (cab, filas) => `<div class="table-wrap"><table class="tbl"><thead><tr>${cab.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${filas || `<tr><td colspan="${cab.length}" class="muted small">Sin datos todavía.</td></tr>`}</tbody></table></div>`;
  return `<div class="hero jefe"><div class="hero-ic">🎯</div><div><h2>Pauta → Venta</h2><p>Qué anuncios venden, a quién atender primero y qué cotizaciones recuperar</p></div></div>
    <div class="grid g-kpi">${kpi('📥 Leads', L, 'con o sin anuncio')}${kpi('📝 Cotizados', CZ, pct(CZ, L) + ' de los leads')}${kpi('💰 Vendidos', V, pct(V, L) + ' de los leads', V ? 'ok' : '')}${kpi('🔥 Por atender', Q.length, `${calientes} calientes con espera`, calientes ? 'bad' : 'ok')}</div>
    ${ia.length ? `<div class="notice"><i class="ti ti-bulb"></i><div>${ia.map(esc).join('<br>')}</div></div>` : ''}
    <div class="card"><div class="card-h"><h3>Rendimiento por anuncio</h3></div>${tabla(['Anuncio', 'Leads', 'Contactados', 'Cotizados', 'Ventas', 'Conversión'], P.map(x => `<tr><td><b>${esc(x.anuncio)}</b></td><td>${x.leads}</td><td>${x.contactados}</td><td>${x.cotizados}</td><td>${x.ventas}</td><td>${x.conversion_pct === null || x.conversion_pct === undefined ? '—' : String(x.conversion_pct).replace('.', ',') + '%'}</td></tr>`).join(''))}</div>
    <div class="card"><div class="card-h"><h3>Leads por atender primero</h3><span class="tiny muted">Calientes arriba · minutos sin respuesta</span></div>${tabla(['Cliente', 'Moto', 'Temperatura', 'Asesor', 'Espera'], Q.map(x => `<tr><td><b data-act="abrir" data-id="${esc(x.id_lead)}" style="cursor:pointer">${esc(x.nombre_completo || 'Sin nombre')}</b></td><td>${esc(x.modelo_interes || '—')}</td><td>${x.temperatura ? pillTemp(canonTemp(x.temperatura)) : '—'}</td><td>${esc(x.nombre_asesor || 'Sin asesor')}</td><td>${x.minutos_sin_respuesta === null || x.minutos_sin_respuesta === undefined ? '—' : fmtHoras(Number(x.minutos_sin_respuesta) / 60)}</td></tr>`).join(''))}</div>
    <div class="card"><div class="card-h"><h3>Cotizaciones por reactivar</h3><span class="tiny muted">Más de 3 días sin cerrar</span></div>${tabla(['Cliente', 'Moto', 'Días', 'Plan', 'Asesor', ''], R.map(x => `<tr><td><b>${esc(x.cliente || '—')}</b></td><td>${esc(x.modelo || '—')}</td><td>${x.dias_sin_cerrar}</td><td>${esc(String(x.plan || '').replace(/_/g, ' '))}</td><td>${esc(x.asesor || '—')}</td><td>${wa(x.telefono) ? `<a class="btn btn-sm" href="${esc(wa(x.telefono))}" target="_blank" rel="noopener"><i class="ti ti-brand-whatsapp"></i> Escribir</a>` : ''}</td></tr>`).join(''))}</div>
    <div class="card"><div class="card-h"><h3>Asesores del mes</h3></div>${tabla(['Asesor', 'Leads', 'Contactados', 'Ventas'], A.map(x => `<tr><td><b>${esc(x.asesor)}</b></td><td>${x.leads}</td><td>${x.contactados}</td><td>${x.ventas}</td></tr>`).join(''))}</div>`;
}

/** Pauta de Facebook e Instagram (exporte de Ads Manager pegado en la hoja Pauta_Meta). */
function cargarPauta() {
  if (S.pauBusy) return; S.pauBusy = true;
  api('pauta').then(r => { S.pau = r; S.pauErr = ''; S.pauT = Date.now(); }).catch(e => { S.pauErr = e.message; S.pauT = Date.now(); })
    .finally(() => { S.pauBusy = false; if (S.view === 'pauta') render(); });
}
function vPauta() {
  if (!S.pau || Date.now() - (S.pauT || 0) > 120e3) cargarPauta();
  if (!S.pau) return S.pauErr ? `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div>${esc(S.pauErr)}</div></div>` : '<div class="loading"><div><i class="ti ti-loader-2 spin"></i> Leyendo la pauta…</div></div>';
  const r = S.pau, t = r.totales || {}, A = r.anuncios || [], cls = S.data.user.rol === 'jefe' ? 'jefe' : 'admin';
  const cpc = t.resultados ? Math.round(t.gasto / t.resultados) : null, ctr = t.impresiones ? (t.clics * 100 / t.impresiones).toFixed(1).replace('.', ',') : '—';
  const conv = A.filter(a => a.costoConversacion !== null).sort((a, b) => a.costoConversacion - b.costoConversacion);
  const ia = [];
  if (conv.length > 1) ia.push(`✅ «${conv[0].anuncio}» es el más barato: ${money(conv[0].costoConversacion)} por conversación (${conv[0].resultados} conversaciones).`, `⚠️ «${conv[conv.length - 1].anuncio}» cuesta ${money(conv[conv.length - 1].costoConversacion)} por conversación.`);
  const sinEntrega = A.filter(a => /not_delivering|inactive|paused/i.test(a.estado) && a.gasto === 0).length; if (sinEntrega) ia.push(`⏸️ ${sinEntrega} anuncio${sinEntrega === 1 ? '' : 's'} sin entrega y sin gasto en el período.`);
  if (A.length && A.every(a => a.leads === null)) ia.push('🔗 Para saber leads, cotizaciones y ventas por anuncio, el lead debe guardar el nombre del anuncio de origen (campo «anuncio_origen»): hoy ninguno coincide con la pauta.');
  if (r.sinPunto) ia.push(`📍 ${r.sinPunto} fila${r.sinPunto === 1 ? '' : 's'} sin punto: agrega la columna «punto» (Itagüí o Los Colores) en la hoja.`);
  const fm = x => x === null || x === undefined ? '—' : money(x), n0 = x => x === null || x === undefined ? '—' : x;
  return `${hero(cls, 'ti-brand-meta', 'Pauta en Facebook e Instagram', `${r.filas} fila${r.filas === 1 ? '' : 's'} leídas de Ads Manager`)}
    ${!r.hoja ? `<div class="pn-card"><h3>Cómo cargar la pauta</h3><ol class="small"><li>En Ads Manager exporta el reporte de <b>Anuncios</b> (CSV) del período que quieras.</li><li>Pega las filas en la hoja <b>Pauta_Meta</b> del libro de Leads (con los mismos encabezados).</li><li>Agrega al final la columna <b>punto</b> con «Itagüí» o «Los Colores».</li><li>Para cruzar con leads, completa en la hoja <b>Pauta_Mapeo</b> el asesor y el «alias_en_lead» (el texto que el bot guarda en anuncio_origen).</li><li>Vuelve aquí: se actualiza solo.</li></ol></div>` : `
    ${kpiRow([['Inversión', money(t.gasto), 'COP en el período'], ['Conversaciones iniciadas', t.resultados || 0, 'por mensaje en WhatsApp/Messenger'], ['Costo por conversación', fm(cpc), 'promedio'], ['Impresiones', num(t.impresiones) ?? 0, `alcance ${num(t.alcance) ?? 0}`], ['Clics en el enlace', t.clics || 0, `CTR ${ctr} %`]])}
    ${ia.length ? `<div class="lectura"><b>🤖 Lectura de la pauta</b>${ia.map(x => `<div class="small" style="margin-top:4px">${esc(x)}</div>`).join('')}</div>` : ''}
    <div class="pn-card"><h3>📍 Por punto</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Punto</th><th class="r">Inversión</th><th class="r">Conversaciones</th><th class="r">Costo/conv.</th><th class="r">Impresiones</th><th class="r">Clics</th></tr></thead><tbody>${(r.puntos || []).map(p => `<tr><td><b>${esc(p.punto)}</b></td><td class="r">${money(p.gasto)}</td><td class="r">${p.resultados}</td><td class="r">${fm(p.costoConversacion)}</td><td class="r">${num(p.impresiones)}</td><td class="r">${p.clics}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="pn-card" style="margin-top:14px"><h3>📣 Por anuncio</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Anuncio</th><th>Punto</th><th>Estado</th><th class="r">Inversión</th><th class="r">Conv.</th><th class="r">Costo/conv.</th><th class="r">CTR</th><th class="r">Leads</th><th class="r">Ventas</th><th class="r">Costo/venta</th></tr></thead><tbody>${A.map(a => `<tr><td><b>${esc(a.anuncio)}</b><div class="tiny muted">${esc(a.desde)} → ${esc(a.hasta)}${a.asesor ? ' · ' + esc(a.asesor) : ''}</div></td><td>${esc(a.punto)}</td><td class="small">${esc(a.estado)}</td><td class="r">${money(a.gasto)}</td><td class="r">${a.resultados}</td><td class="r">${fm(a.costoConversacion)}</td><td class="r">${a.ctr === null ? '—' : String(a.ctr).replace('.', ',') + ' %'}</td><td class="r">${n0(a.leads)}</td><td class="r">${n0(a.ventas)}</td><td class="r">${fm(a.costoVenta)}</td></tr>`).join('')}</tbody></table></div></div>`}`;
}
function filtrosPanel(p) {
  const f = p.filtro || {}, sedeSel = f.sede || '', diasSel = f.dias || 30, b = (k, v, txt, on) => `<button class="${on ? 'on' : ''}" data-act="pan-filtro" data-k="${k}" data-v="${v}">${txt}</button>`;
  return `<div class="row wrap" style="gap:10px;margin:0 0 12px"><div class="seg">${b('sede', '', 'Antioquia', !sedeSel)}${b('sede', 'Itagüí', 'Itagüí', sedeSel === 'Itagüí')}${b('sede', 'Los Colores', 'Los Colores', sedeSel === 'Los Colores')}</div><div class="seg">${b('dias', 1, 'Hoy', diasSel === 1)}${b('dias', 7, 'Semana', diasSel === 7)}${b('dias', 30, 'Mes', diasSel === 30)}</div></div>`;
}
function kpiP(clave, l, v, s, cls) { return `<div data-act="panel-f" data-k="${clave}" title="Toca para ver la lista" style="cursor:pointer;border-radius:14px;${S.panF === clave ? 'outline:3px solid #2563eb;' : ''}">${kpi(l, v, s, cls)}</div>`; }
/** Actividad frente a resultado por asesor: referente, eficiente, alta actividad con bajo resultado, o baja actividad. */
function clasificarEquipo(p) {
  const act = (p.control.asesores || []), seg = e => ((act.find(a => mismaPersona(a.k, e.nombre)) || {}).seguimientos) || 0;
  const filas = p.equipo.map(e => ({ e, seg: seg(e) })), segs = filas.map(f => f.seg).filter(x => x > 0), convs = p.equipo.map(e => e.conversion).filter(x => x !== null);
  const avgSeg = segs.length ? segs.reduce((a, b) => a + b, 0) / segs.length : 0, avgConv = convs.length ? convs.reduce((a, b) => a + b, 0) / convs.length : 0;
  return filas.map(f => {
    const e = f.e, tiene = f.seg > 0 || e.cotizaciones >= 3; if (!tiene) return { ...f, tag: '—', nota: '' };
    const altaAct = f.seg >= avgSeg, altoRes = (e.conversion || 0) >= avgConv;
    return { ...f, tag: altaAct && altoRes ? '🟢 Referente' : (altaAct ? '🟠 Alta actividad / bajo resultado' : (altoRes ? '🔵 Eficiente' : '🔴 Baja actividad / bajo resultado')),
      nota: altaAct && !altoRes ? `${e.nombre.split(' ')[0]}: ${f.seg} seguimientos y ${e.ventas} venta${e.ventas === 1 ? '' : 's'}. Revisar calidad de negociación y manejo de objeciones.` : (!altaAct && !altoRes ? `${e.nombre.split(' ')[0]}: baja actividad y bajo resultado. Es un tema de disciplina comercial.` : '') };
  });
}
function vInteligencia() {
  const c = panelListo(); if (c) return c;
  const p = S.pan, ctl = p.control, k = ctl.kpis || {}, L = ctl.lista || [], conT = k.conTiempoContacto || 0;
  const lect = [];
  if (k.sinContacto) lect.push(`Hay ${k.sinContacto} lead${k.sinContacto === 1 ? '' : 's'} sin contactar. Cada hora sin respuesta baja la probabilidad de venta.`);
  if (k.cotizadosSinSoporte) lect.push(`${k.cotizadosSinSoporte} lead${k.cotizadosSinSoporte === 1 ? ' marcado' : 's marcados'} como cotizado${k.cotizadosSinSoporte === 1 ? '' : 's'} no cruza${k.cotizadosSinSoporte === 1 ? '' : 'n'} con ninguna cotización del CRM.`);
  if (conT && pctDe(k.contactoEn2h || 0, conT) < 70) lect.push(`Solo el ${pctDe(k.contactoEn2h || 0, conT)} % de los leads se contacta en las primeras 2 horas (la meta es 70 % o más).`);
  if (k.reasignados) lect.push(`${k.reasignados} lead${k.reasignados === 1 ? ' cambió' : 's cambiaron'} de asesor: revisa el motivo en «Reasignaciones recientes».`);
  if (!lect.length) lect.push(L.length ? '🟢 La gestión de leads está al día: sin pendientes críticos ahora mismo.' : 'Aún no hay leads en este período: cuando entren por la pauta o por referidos aparecerán aquí.');
  const funnel = [['Leads recibidos', k.recibidos || 0], ['Contactados', k.contactados || 0], ['Cotizados', k.cotizaciones || 0], ['Con cotización en el CRM', Math.max(0, (k.cotizaciones || 0) - (k.cotizadosSinSoporte || 0))], ['Vendidos (Síntesis)', k.ventas || 0]];
  const mx = Math.max(1, ...funnel.map(x => x[1])), T = (ctl.tareas || []).slice(0, 6);
  return `${hero('jefe', 'ti-brain', 'Gestión de Leads', `Pauta en redes y referidos · ${esc((p.filtro || {}).sede || 'Todos los puntos')}`)}
    ${filtrosPanel(p)}
    ${kpisGestion(ctl)}
    ${S.panF ? `<div class="pn-card" style="margin-top:12px">${pulsoLista(ctl, S.panF, 'panel-f')}</div>` : ''}
    <div class="lectura"><b>🧠 Lectura de hoy</b>${lect.map(x => `<div style="margin-top:4px">${esc(x)}</div>`).join('')}</div>
    <div class="pn-grid">
      <div class="pn-card"><h3>📣 Por origen</h3>${tablaOrigen(ctl)}</div>
      <div class="pn-card"><h3>📊 Embudo</h3>${L.length ? funnel.map(f => `<div class="fn-row"><span class="fn-lbl">${f[0]}</span><div class="fn-bar" style="width:${Math.max(6, Math.round(f[1] * 100 / mx))}%">${f[1]}</div></div>`).join('') : '<p class="small muted">Sin movimiento todavía en este período.</p>'}</div>
    </div>
    <div class="pn-card"><h3>👥 Asesores: contacto, cotización y reasignación</h3>${tablaAsesores(ctl)}<p class="tiny muted" style="margin:8px 0 0">«1er contacto» es la mediana entre que entra el lead y el asesor lo contacta. «Sin cotización CRM»: el asesor lo marcó cotizado y no aparece en el CRM. «Vendidos» solo cuenta ventas que cruzan con Síntesis.</p></div>
    <div class="pn-grid">
      <div class="pn-card"><h3>🔁 Reasignaciones recientes</h3>${listaReasignaciones(ctl)}</div>
      <div class="pn-card"><h3>🚨 Alertas recientes</h3>${listaAlertas(ctl)}<button class="btn btn-sm" style="margin-top:8px" data-nav="control">Ver todo en Control →</button></div>
    </div>
    <div class="pn-card"><div class="row between wrap"><h3 style="margin:0">⚡ Por atender ahora</h3><button class="btn btn-sm" data-act="panel-f" data-k="atender">Ver todas</button></div>${T.length ? T.map(t => `<div class="small" style="margin:8px 0">${t.prioridad <= 1 ? '🔴' : t.prioridad === 2 ? '🟠' : '🟡'} <b data-act="abrir" data-id="${esc(t.id_lead)}" style="cursor:pointer">${esc(t.nombre)}</b> · ${esc(t.tarea)}${t.asesor ? ` <span class="tiny muted">· ${esc(t.asesor)}</span>` : ''}</div>`).join('') : '<p class="small muted">Sin pendientes ✅</p>'}</div>`;
}
function vPunto() {
  const c = panelListo(); if (c) return c;
  const p = S.pan, ctl = p.control, L = ctl.lista || [], sede = (p.sedes[0] || {}).sede || p.sede;
  const tab = S.ptTab || 'activos', T = (ctl.tareas || []).slice(0, 6);
  const lista = tab === 'sincontacto' ? L.filter(l => l.abierto && l.sinContacto) : tab === 'sinsoporte' ? L.filter(l => l.sinSoporte) : tab === 'perdidos' ? L.filter(l => l.estado === 'Perdido') : L.filter(l => l.abierto);
  return `${hero('admin', 'ti-building-store', `Mi Punto – ${esc(sede)}`, `Administrador: ${esc(S.data.user.nombre)} · pauta en redes y referidos`)}
    ${kpisGestion(ctl)}
    ${S.panF ? `<div class="pn-card" style="margin-top:12px">${pulsoLista(ctl, S.panF, 'panel-f')}</div>` : ''}
    <div class="pn-grid">
      <div class="pn-card"><h3>👥 Mi equipo</h3>${tablaAsesores(ctl, { click: true })}<p class="tiny muted">Toca un asesor para ver sus leads. La reasignación la decide el Jefe: usa «Solicitar reasignación» en el lead.</p></div>
      <div class="pn-card"><h3>📣 Por origen</h3>${tablaOrigen(ctl)}<h3 style="margin-top:14px">🔁 Reasignaciones recientes</h3>${listaReasignaciones(ctl)}</div>
    </div>
    <div class="pn-card"><h3>⚡ Por atender ahora</h3>${T.length ? T.map(t => `<div class="small" style="margin:8px 0">${t.prioridad <= 1 ? '🔴' : t.prioridad === 2 ? '🟠' : '🟡'} <b data-act="abrir" data-id="${esc(t.id_lead)}" style="cursor:pointer">${esc(t.nombre)}</b> · ${esc(t.tarea)}${t.asesor ? ` <span class="tiny muted">· ${esc(t.asesor)}</span>` : ''}</div>`).join('') : '<p class="small muted">Sin pendientes ✅</p>'}</div>
    <div class="pn-card"><div class="row between wrap" style="margin-bottom:8px"><h3 style="margin:0">Leads del punto</h3><div class="seg">${[['activos', `Activos (${L.filter(l => l.abierto).length})`], ['sincontacto', 'Sin contacto'], ['sinsoporte', 'Sin cotización CRM'], ['perdidos', 'Perdidos']].map(t => `<button class="${tab === t[0] ? 'on' : ''}" data-tab="ptTab" data-v="${t[0]}">${t[1]}</button>`).join('')}</div></div>${tablaOport(lista.slice(0, 40), true)}</div>`;
}
function vEquipo() {
  const c = panelListo(); if (c) return c;
  const p = S.pan, L = p.control.lista || [], sel = S.eqSel;
  const mis = sel ? L.filter(l => norm(l.asesor) === norm(sel) && l.abierto) : [];
  return `${hero('admin', 'ti-users', 'Mi equipo', `${esc(p.sede)}`)}
    <div class="pn-card"><h3>Asesores del punto</h3>${tablaAsesores(p.control, { click: true })}</div>
    ${sel ? `<div class="pn-card" style="margin-top:14px"><div class="row between wrap"><h3 style="margin:0">Leads de ${esc(sel)} <span class="pill">${mis.length}</span></h3><button class="btn btn-sm" data-act="eq-sel" data-id="">Cerrar</button></div>${tablaOport(mis.slice(0, 60), false)}</div>` : ''}`;
}
function vDia() {
  const c = panelListo(); if (c) return c;
  const u = S.data.user, p = S.pan, ctl = p.control, k = ctl.kpis || {}, L = ctl.lista || [], conT = k.conTiempoContacto || 0;
  const abiertos = L.filter(l => l.abierto), sinCont = abiertos.filter(l => l.sinContacto), sinSop = L.filter(l => l.sinSoporte);
  const top = p.top.slice(0, 5), tareas = (ctl.tareas || []).slice(0, 6), hoyCitas = p.citas.filter(x => x.fecha === ymd(new Date())).length;
  const coach = [];
  if (sinCont.length) coach.push(`Tienes ${sinCont.length} lead${sinCont.length === 1 ? '' : 's'} sin contactar: empieza por ${sinCont[0].nombre}. El que responde primero, vende.`);
  if (sinSop.length) coach.push(`${sinSop.length} lead${sinSop.length === 1 ? ' marcado' : 's marcados'} como cotizado sin cotización en el CRM: regístrala allá con el mismo celular o corrige el estado.`);
  if (!coach.length) coach.push(top.length ? `Empieza por ${top[0].nombre}: score ${top[0].score}${top[0].ia ? ' · ' + top[0].ia.replace(/^[^\w¿¡]+/, '') : ''}` : 'No tienes leads abiertos: espera nuevos leads o retoma clientes por recuperar.');
  return `${hero('asesor', 'ti-user', `Mi Día — ${esc(u.nombre.split(' ').slice(0, 2).join(' '))}`, `${abiertos.length} lead${abiertos.length === 1 ? '' : 's'} abierto${abiertos.length === 1 ? '' : 's'} · ${sinCont.length} sin contactar`)}
    ${kpiRow([['Leads abiertos', abiertos.length, 'asignados a ti'], ['Sin contactar', sinCont.length, 'contáctalos ya', sinCont.length ? 'bad' : 'ok'], ['Cotizados', k.cotizaciones || 0, `${k.cotizadosSinSoporte || 0} sin cotización en el CRM`, k.cotizadosSinSoporte ? 'warn' : 'ok'], ['Citas de hoy', hoyCitas, ''], ['Vendidos', k.ventas || 0, 'cruzados con Síntesis']])}
    ${iaCard('asesor', 'Mi Coach IA', coach, `<button class="btn btn-sm" data-nav="hoy">Ver mis leads →</button>`)}
    <div class="pn-card"><h3>🎯 Mis ${top.length || ''} clientes para atender hoy</h3>${tablaOport(top, false)}</div>
    <div class="pn-grid">
      <div class="pn-card"><h3>📋 Mis pendientes de hoy</h3>${[...p.citas.slice(0, 4).map(x => `<div class="small" style="margin:6px 0">📅 <b>${esc(x.fecha.slice(5))} ${esc(x.hora)}</b> · ${esc(x.nombre)} · ${esc(x.tipo)}</div>`), ...tareas.map(t => `<div class="small" style="margin:6px 0">${t.prioridad <= 1 ? '🔴' : t.prioridad === 2 ? '🟠' : '🟡'} <b data-act="abrir" data-id="${esc(t.id_lead)}" style="cursor:pointer">${esc(t.nombre)}</b> · ${esc(t.tarea)}</div>`)].join('') || '<p class="small muted">Sin pendientes por ahora ✅</p>'}</div>
      <div class="pn-card"><h3>⏱️ Mi atención</h3>
        <div class="row between small" style="margin:8px 0"><span>Primer contacto (mediana)</span><b>${txtT(k.mediana1raRespuestaH)}</b></div>
        <div class="row between small" style="margin:8px 0"><span>Contactados en 15 min</span><b>${txtPct(pctDe(k.contactoEn15min || 0, conT))}</b></div>
        <div class="row between small" style="margin:8px 0"><span>Contactados en 2 h</span><b>${txtPct(pctDe(k.contactoEn2h || 0, conT))}</b></div>
        <div class="row between small" style="margin:8px 0"><span>Leads que cambiaron de asesor</span><b>${k.reasignados || 0}</b></div>
        <p class="tiny muted" style="margin:10px 0 0">Meta: contactar en 15 min los calientes y en 2 h el resto, en horario hábil.</p></div>
    </div>`;
}
function vCitas() {
  const c = panelListo(); if (c) return c;
  const p = S.pan, rows = p.citas;
  return `${hero(S.data.user.rol === 'asesor' ? 'asesor' : 'admin', 'ti-calendar-event', S.data.user.rol === 'asesor' ? 'Mis citas' : 'Citas', 'Próximas visitas y revisiones técnicas')}
    <div class="pn-card">${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Hora</th><th>Cliente</th><th>Tipo</th></tr></thead><tbody>${rows.map(x => `<tr><td>${esc(x.fecha)}</td><td>${esc(x.hora)}</td><td><b data-act="abrir" data-id="${esc(x.id_lead)}" style="cursor:pointer">${esc(x.nombre)}</b></td><td>${esc(x.tipo)}</td></tr>`).join('')}</tbody></table></div>` : empty('ti-calendar-off', 'No hay citas próximas.')}</div>`;
}
/** Cotizaciones / ventas del mes / entregas, según el alcance del cargo. Las ventas permiten validar el asesor (jefe y administrador). */
function vListaPanel(kind) {
  const c = panelListo(); if (c) return c;
  const u = S.data.user, p = S.pan, L = p.control.lista || [], cls = u.rol === 'asesor' ? 'asesor' : (u.rol === 'admin' ? 'admin' : 'jefe');
  const team = (S.M.asesores || []).filter(a => u.rol === 'jefe' || a.sedeCanon === u.sede);
  let titulo, cuerpo;
  if (kind === 'cotizaciones') { titulo = u.rol === 'asesor' ? 'Mis cotizaciones' : 'Cotizaciones'; cuerpo = tablaOport(L.filter(l => l.cotizado && l.abierto), u.rol !== 'asesor'); }
  else if (kind === 'ventas') {
    titulo = u.rol === 'asesor' ? 'Mis ventas del mes' : 'Ventas del mes (por punto)';
    const V = p.control.facturasMes || [];
    cuerpo = V.length ? `<p class="small muted">Cada venta cuenta para el <b>punto</b> de donde sale la moto. ${u.rol === 'asesor' ? '' : 'Confirma o corrige el asesor de las que aparecen «por validar».'}</p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Factura</th><th>Cliente</th><th>Moto</th><th>Punto</th><th>Asesor</th><th class="r">Valor</th></tr></thead><tbody>${V.map(f => `<tr><td>${esc(f.id_factura)}</td><td>${esc(f.cliente)}</td><td>${esc(f.modelo)}</td><td>${esc(f.sede)}</td><td>${esc(f.asesor || '—')}${f.validada ? ' ✅' : (u.rol === 'asesor' ? '' : `<div class="row" style="gap:4px;margin-top:4px"><select class="sel" id="val-as-${esc(f.id_factura)}">${opts(team.map(a => a.nombre), (team.find(a => mismaPersona(a.nombre, f.asesor)) || {}).nombre || '', 'Asesor…')}</select><button class="btn btn-sm btn-dark" data-act="val-venta" data-id="${esc(f.id_factura)}">Validar</button></div>`)}</td><td class="r">${money(num(f.valor))}</td></tr>`).join('')}</tbody></table></div>` : empty('ti-report-money', 'Aún no hay ventas facturadas este mes.');
  } else {
    titulo = u.rol === 'asesor' ? 'Mis entregas' : 'Entregas';
    const pend = L.filter(l => l.pendEntrega), ent = L.filter(l => l.entregada);
    cuerpo = `<h4>⏳ Pendientes de entrega (${pend.length})</h4>${pend.length ? pend.map(l => `<div class="card" style="margin-bottom:6px;padding:8px 12px"><b data-act="abrir" data-id="${esc(l.id)}" style="cursor:pointer">${esc(l.nombre)}</b> <span class="muted small">· ${esc(l.producto)} · ${esc(l.sede)}${l.asesor ? ' · ' + esc(l.asesor) : ''}</span> <button class="btn btn-sm btn-dark" data-act="entrega-rapida" data-id="${esc(l.id)}"><i class="ti ti-motorbike"></i> Marcar entregada</button></div>`).join('') : '<p class="small muted">Nada pendiente ✅</p>'}<h4 style="margin-top:14px">🏍️ Entregadas (${ent.length})</h4>${ent.length ? ent.map(l => `<div class="small" style="margin:4px 0">${esc(l.nombre)} · ${esc(l.producto)}</div>`).join('') : '<p class="small muted">Aún no hay entregas registradas.</p>'}`;
  }
  return `${hero(cls, 'ti-list-details', titulo, esc(fmtMes(p.mes)))}<div class="pn-card">${cuerpo}</div>`;
}

// ── Navegación ────────────────────────────────────────────────────────────
// Cada cargo ve su propio menú (y el API valida el cargo en cada ruta: ocultar un botón no basta).
function vistasDeRol() {
  // Las pantallas que solo calculan sobre leads (Indicadores, Conciliación, Leads/Embudo del Admin) se ocultan mientras haya muy pocos leads: vuelven solas con volumen.
  const pocos = ((S.M && S.M.leads) || []).length < 15, ocultas = pocos ? { indicadores: 1, conciliacion: 1 } : {};
  return vistasDeRolBase().filter(v => !ocultas[v.id] && !(pocos && S.data.user.rol === 'admin' && v.id === 'embudo'));
}
function vistasDeRolBase() {
  const r = S.data.user.rol, it = (id, icon, label) => ({ id, icon, label });
  // v2.33 — la app solo gestiona leads de pauta en redes y referidos. Inventario, bonos, metas, cifras, comisiones, entregas y posventa ya no se muestran
  // (el inventario y los bonos los lee solo el agente IA; la información comercial vive en el CRM de la empresa). Los datos siguen guardados.
  if (r === 'asesor') return [it('dia', 'ti-sun', 'Mi Día'), it('hoy', 'ti-checklist', 'Mis Leads'), it('chats', 'ti-messages', 'Mis Chats'), it('miscot', 'ti-file-dollar', 'Mis Cotizaciones'),
    it('seguimientos', 'ti-clipboard-check', 'Mis Seguimientos'), it('citas', 'ti-calendar-event', 'Mis Citas')];
  if (r === 'admin') return [it('hoy', 'ti-checklist', 'Hoy'), it('punto', 'ti-building-store', 'Mi Punto'), it('equipo', 'ti-users', 'Equipo'), it('embudo', 'ti-layout-kanban', 'Leads'), it('chats', 'ti-messages', 'Chats'),
    it('seguimientos', 'ti-clipboard-check', 'Seguimiento'), it('cotizaciones', 'ti-file-dollar', 'Cotizaciones'), it('pauta', 'ti-brand-meta', 'Pauta Meta'), it('alertas', 'ti-bell-ringing', 'Alertas')];
  return [it('hoy', 'ti-checklist', 'Hoy'), it('inteligencia', 'ti-brain', 'Gestión de Leads'), it('icventas', 'ti-target-arrow', 'Pauta → Venta'), it('embudo', 'ti-layout-kanban', 'Embudo'), it('chats', 'ti-messages', 'Chats'), it('disponibilidad', 'ti-user-check', 'Disponibilidad'), it('zonas', 'ti-map-2', 'Zonas'), it('control', 'ti-radar-2', 'Control'),
    it('indicadores', 'ti-chart-dots', 'Indicadores'), it('analista', 'ti-chart-histogram', 'Tablero'), it('seguimientos', 'ti-clipboard-check', 'Seguimiento'),
    it('cotizaciones', 'ti-file-dollar', 'Cotizaciones'), it('pauta', 'ti-brand-meta', 'Pauta Meta'),
    it('conciliacion', 'ti-git-compare', 'Conciliación'), it('auditoria', 'ti-history', 'Auditoría'), it('accesos', 'ti-link', 'Accesos'), it('config', 'ti-settings', 'Ajustes')];
}
function homeDeRol() { return ({ jefe: 'inteligencia', admin: 'punto', asesor: 'dia' })[S.data.user.rol] || 'hoy'; }
function vistasDeRolViejas() {
  const r = S.data.user.rol;
  const v = [
    { id: 'hoy', icon: 'ti-checklist', label: 'Hoy' },
    { id: 'chats', icon: 'ti-messages', label: 'Chats' },
    { id: 'embudo', icon: 'ti-layout-kanban', label: 'Embudo' },
    { id: 'control', icon: 'ti-radar-2', label: 'Control' },
    { id: 'metas', icon: 'ti-target', label: 'Metas' },
    { id: 'ventas', icon: 'ti-report-money', label: 'Cifras' },
    { id: 'indicadores', icon: 'ti-chart-dots', label: 'Indicadores' }
  ];
  if (r !== 'asesor') v.push({ id: 'analista', icon: 'ti-chart-histogram', label: 'Tablero' });
  v.push({ id: 'seguimientos', icon: 'ti-clipboard-check', label: 'Seguimiento' });
  v.push({ id: 'posventa', icon: 'ti-tool', label: 'Posventa' });
  if (r !== 'asesor') {
    v.push({ id: 'inventario', icon: 'ti-building-warehouse', label: 'Inventario' });
    v.push({ id: 'cotizaciones', icon: 'ti-file-dollar', label: 'Cotizaciones' });
  }
  v.push({ id: 'comisiones', icon: 'ti-coin', label: 'Comisiones' });
  if (r === 'jefe') {
    v.push({ id: 'conciliacion', icon: 'ti-git-compare', label: 'Conciliación' });
    v.push({ id: 'accesos', icon: 'ti-link', label: 'Accesos' });
    v.push({ id: 'config', icon: 'ti-settings', label: 'Ajustes' });
  }
  return v;
}
function renderNav() {
  const M = S.M;
  const badges = {
    hoy: M.leads.filter(l => l.sla === 'bad' || l.citaHoy).length,
    chats: (S.bandeja || []).filter(c => c.espera && c.estado !== 'bot').length,
    conciliacion: M.leads.filter(l => l.incons.length).length
  };
  $('#nav').innerHTML = vistasDeRol().map(v =>
    `<button data-nav="${v.id}" class="${S.view === v.id ? 'on' : ''}"><i class="ti ${v.icon}"></i><span>${v.label}</span>${badges[v.id] ? `<span class="dot">${badges[v.id]}</span>` : ''}</button>`).join('');
}
function render() {
  const base = { pauta: vPauta, icventas: vICVentas, inteligencia: vInteligencia, punto: vPunto, dia: vDia, equipo: vEquipo, miscot: () => vListaPanel('cotizaciones'), misventas: () => vListaPanel('ventas'), entregas: () => vListaPanel('entregas'), citas: vCitas,
    alertas: () => vControlTab('alertas'), auditoria: () => vControlTab('auditoria'), hoy: vHoy, chats: vChats, embudo: vEmbudo, control: vControl, metas: vMetas, indicadores: vIndicadores, analista: vAnalista, comisiones: vComisiones, conciliacion: vConciliacion, accesos: vAccesos, config: vConfig, disponibilidad: vDisponibilidad, zonas: vZonas };
  const fn =(MOD && MOD.views[S.view]) || base[S.view];
  const sinCambio = S._vistaPrev === S.view;
  $('#view').innerHTML = fn();
  if (S.view === 'embudo') bindKanban();
  if (!sinCambio) animarNumeros(); // el conteo animado solo al cambiar de vista, no en cada actualización automática
  S._vistaPrev = S.view;
}

// ── Componentes ───────────────────────────────────────────────────────────
function toast(msg, tipo) {
  const t = document.createElement('div');
  t.className = 'toast ' + (tipo || '');
  t.innerHTML = `<i class="ti ${tipo === 'bad' ? 'ti-alert-circle' : tipo === 'ok' ? 'ti-circle-check' : 'ti-info-circle'}"></i><div>${esc(msg)}</div>`;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), tipo === 'bad' ? 6500 : 3200);
}
function empty(icon, txt) { return `<div class="empty"><i class="ti ${icon}"></i>${txt}</div>`; }
// Nombres que ve el usuario: Retenido = «Detenido»; Facturado con la venta ya en Síntesis = «Cerrado ganado».
function lblEstado(e, cerrado) { return e === 'Retenido' ? 'Detenido' : e === 'Facturado' ? (cerrado ? 'Cerrado ganado' : 'Pasa a facturar') : e; }
function pillEstado(e, cerrado) {
  const c = { Nuevo: 'pill-info', Contactado: '', Cotizado: 'pill-warn', Facturado: 'pill-ok', Perdido: 'pill-bad', Retenido: 'pill-dark', 'Otra ciudad': 'pill-dark' }[e] || '';
  return `<span class="pill ${c}">${cerrado && e === 'Facturado' ? '<i class="ti ti-circle-check"></i> ' : ''}${esc(lblEstado(e, cerrado))}</span>`;
}
function pillTemp(t, pref) { return t ? `<span class="pill t-${norm(t)}">${pref || ''}${esc(t)}</span>` : ''; }
// Ícono del KPI según lo que mide (el texto de la etiqueta decide)
const KPI_ICONOS = [[/nps|satisf|promotor/, 'ti-heart-handshake'], [/meta/, 'ti-target-arrow'], [/vend|factur|moto|entreg|ganad/, 'ti-motorbike'], [/cotiz|simul/, 'ti-file-dollar'],
  [/contact|respuesta|1ª|primera/, 'ti-phone-check'], [/cita|asist|visit/, 'ti-calendar-check'], [/valor|ticket|\$|comis|ingres/, 'ti-coin'], [/perd|rechaz/, 'ti-trending-down'],
  [/conver|%|tasa/, 'ti-arrows-exchange'], [/sla|venc|alerta|atras|incons/, 'ti-alarm'], [/chat|mensaj|espera/, 'ti-messages'], [/lead|asignad|nuevos|total|cliente/, 'ti-users'], [/invent|stock|exist|dispon/, 'ti-building-warehouse']];
function kpiIcono(l) { const t = norm(String(l).replace(/<[^>]*>/g, '')); const m = KPI_ICONOS.find(([re]) => re.test(t)); return m ? m[1] : 'ti-chart-bar'; }
function kpi(l, v, s, cls) { return `<div class="kpi ${cls || ''}"><i class="k-ico ti ${kpiIcono(l)}"></i><div class="k-l">${l}</div><div class="k-v">${v}</div>${s ? `<div class="k-s">${s}</div>` : ''}</div>`; }
// Los números enteros de los KPI suben desde 0 al entrar a una vista
function animarNumeros() {
  $$('.kpi .k-v').forEach(el => {
    const fin = /^\d{1,6}$/.test(el.textContent.trim()) ? Number(el.textContent.trim()) : null;
    if (fin === null || fin < 3) return;
    const t0 = performance.now(); el.textContent = '0';
    const paso = t => { const k = Math.min((t - t0) / 650, 1); el.textContent = Math.round(fin * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(paso); };
    requestAnimationFrame(paso);
  });
}
function bars(items, opts = {}) {
  if (!items.length) return empty('ti-chart-bar-off', opts.vacio || 'Sin datos en el período.');
  const max = Math.max(...items.map(i => i.v), 1);
  return `<div class="bars">${items.map(i => `<div class="bar-row"><span class="lbl" title="${esc(i.l)}">${esc(i.l)}</span><div class="bar-track"><div class="bar-fill ${i.cls || opts.cls || ''}" style="width:${Math.max(2, i.v / max * 100)}%"></div></div><span class="num r small">${i.t !== undefined ? i.t : i.v}</span></div>`).join('')}</div>`;
}
function contar(arr, fn) {
  const m = {}; arr.forEach(x => { const k = fn(x) || 'Sin dato'; m[k] = (m[k] || 0) + 1; });
  return Object.entries(m).map(([l, v]) => ({ l, v })).sort((a, b) => b.v - a.v);
}
function opts(list, sel, todos) {
  return (todos ? `<option value="">${todos}</option>` : '') + list.map(o => { const v = typeof o === 'object' ? o.v : o, t = typeof o === 'object' ? o.t : o; return `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(t)}</option>`; }).join('');
}
function contactoTxt(l) {
  if (l.tel) return `<span><i class="ti ti-phone"></i>${esc(l.tel.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3'))}</span>`;
  return `<span class="muted"><i class="ti ti-brand-whatsapp"></i>Solo usuario de WhatsApp${l.usuario ? ' (' + esc(l.usuario) + ')' : ''}</span>`;
}
function waLink(l) { return l.tel ? `https://wa.me/57${l.tel}` : ''; }
function puedeEditar(l) {
  const u = S.data.user;
  if (u.rol === 'jefe') return true;
  if (u.rol === 'admin') return l.sede === u.sede;
  return norm(l.asesor) === norm(u.nombre);
}

function iniciales(n) { const p = String(n || '?').trim().split(/\s+/).filter(Boolean); return ((p[0] || '?')[0] + ((p[1] || '')[0] || '')).toUpperCase(); }
function leadCard(l) {
  const timerCls = l.sla || (l.sinCotizar ? 'warn' : '');
  let timer = '';
  if (l.estado === 'Nuevo' && l.hAsign !== null) timer = `<span class="timer ${timerCls}" title="Tiempo hábil sin contacto"><i class="ti ti-clock"></i> ${fmtHoras(l.hAsign)}</span>`;
  else if (l.sinCotizar) timer = `<span class="timer warn" title="Contactado sin cotizar"><i class="ti ti-clock-exclamation"></i> ${fmtHoras(l.hAsign)} sin cotizar</span>`;
  else if (l.cotSinAvance) timer = `<span class="timer warn"><i class="ti ti-hourglass"></i> ${Math.floor(l.diasSinAvance)} d sin avance</span>`;
  const s = l.sla === 'bad' ? 's-bad' : l.citaHoy ? 's-info' : (l.sla === 'warn' || l.sinCotizar || l.cotSinAvance) ? 's-warn' : '';
  const ed = puedeEditar(l);
  const r = l.raw;
  const acciones = [];
  if (ed && l.estado === 'Nuevo') acciones.push(`<button class="btn btn-sm btn-dark" data-act="contactado" data-id="${esc(l.id)}"><i class="ti ti-phone-check"></i> Contactado</button>`);
  if (ed && (l.estado === 'Nuevo' || l.estado === 'Contactado')) acciones.push(`<button class="btn btn-sm" data-act="cotizado" data-id="${esc(l.id)}"><i class="ti ti-file-dollar"></i> Cotizado</button>`);
  if (ed && ['Nuevo', 'Contactado', 'Cotizado', 'Retenido'].includes(l.estado)) acciones.push(`<button class="btn btn-sm" data-act="facturado" data-id="${esc(l.id)}"><i class="ti ti-receipt"></i> Pasa a facturar</button>`);
  if (ed && ['Nuevo', 'Contactado', 'Cotizado'].includes(l.estado)) acciones.push(`<button class="btn btn-sm" data-act="detenido" data-id="${esc(l.id)}" title="No avanza: no hay la moto disponible o está reuniendo el dinero"><i class="ti ti-player-pause"></i> Detenido</button>`);
  if (ed && !['Facturado', 'Perdido'].includes(l.estado)) acciones.push(`<button class="btn btn-sm" data-act="perdido" data-id="${esc(l.id)}"><i class="ti ti-x"></i> Perdido</button>`);
  if (ed && l.cerrado) acciones.push(`<button class="btn btn-sm btn-dark" data-act="abrir" data-id="${esc(l.id)}"><i class="ti ti-tool"></i> Agendar revisión técnica</button>`);
  // Solo el Jefe Comercial cambia el asesor y/o el punto de venta del lead
  if (S.data.user.rol === 'jefe' && l.estado !== 'Perdido') acciones.push(`<button class="btn btn-sm" data-act="cambiar-asig" data-id="${esc(l.id)}" title="Cambiar el asesor y/o el punto de venta de este lead"><i class="ti ti-arrows-exchange"></i> Cambiar asesor / punto</button>`);
  // El chat se atiende dentro de la app con el número del negocio (no desde el WhatsApp personal del asesor)
  acciones.push(`<button class="btn btn-sm btn-wa" data-act="ir-chat" data-id="${esc(l.id)}"><i class="ti ti-messages"></i> Chat</button>`);
  return `<article class="lead ${s}">
    <div class="lead-top"><div class="lead-id"><div class="av av-${norm(l.tempIA || l.temp)}">${esc(iniciales(l.nombre))}</div><div><div class="lead-name" data-act="abrir" data-id="${esc(l.id)}">${esc(l.nombre)}</div>
      <div class="lead-sub">${esc(l.asesor || 'Sin asesor')} · ${esc(l.sede || 'Sin punto')}</div></div></div>
      <div class="row" style="flex-direction:column;align-items:flex-end;gap:4px">${pillEstado(l.estado, l.cerrado)}${timer}</div></div>
    <div class="lead-facts">${contactoTxt(l)}
      ${r.modelo_interes ? `<span><i class="ti ti-motorbike"></i>${esc(r.modelo_interes)}</span>` : ''}
      ${r.zona ? `<span><i class="ti ti-map-pin"></i>${esc(r.zona)}</span>` : ''}
      ${/venta en sala/i.test(r.origen || '') ? '<span class="pill pill-dark"><i class="ti ti-building-store"></i> Venta en sala</span>' : ''}
      ${r.intencion_compra ? `<span><i class="ti ti-target-arrow"></i>${esc(r.intencion_compra)}</span>` : ''}
      ${r.forma_pago ? `<span><i class="ti ti-credit-card"></i>${esc(r.forma_pago)}</span>` : ''}
      ${l.cita ? `<span class="${l.citaHoy ? '' : 'muted'}"><i class="ti ti-calendar-event"></i>${l.citaHoy ? '<b>Cita hoy</b> ' + esc(horaTxt(r.cita_hora) || '') : fmtFecha(l.cita, !!r.cita_hora)}</span>` : ''}
    </div>
    ${l.pendCont ? `<div class="notice bad small" style="padding:6px 10px"><i class="ti ti-alert-triangle"></i><div>Figura como <b>contactado</b> pero no hay mensaje tuyo por WhatsApp. ${ed ? `<button class="btn btn-sm btn-primary" data-act="justificar-contacto" data-id="${esc(l.id)}">Justificar contacto</button>` : 'El asesor debe justificar por dónde y a qué hora lo contactó.'}</div></div>` : ''}
    ${l.incons.length ? `<div class="notice bad small" style="padding:6px 10px"><i class="ti ti-alert-triangle"></i><div>${l.incons.map(esc).join('<br>')}</div></div>` : ''}
    <div class="row between wrap"><div class="tags">${l.tempIA ? pillTemp(l.tempIA, 'IA: ') : '<span class="pill">IA: sin etiqueta</span>'}
      ${ed ? TEMPS.map(t => `<button class="tag-btn t-${norm(t)} ${(l.temp || l.tempIA) === t ? 'on' : ''}" data-act="temp" data-v="${t}" data-id="${esc(l.id)}">${t}</button>`).join('') : pillTemp(l.temp, 'Asesor: ')}</div></div>
    ${acciones.length ? `<div class="lead-actions">${acciones.join('')}</div>` : ''}
  </article>`;
}

// ── Vista: Hoy ────────────────────────────────────────────────────────────
function leadsAlcance() {
  const u = S.data.user;
  let ls = S.M.leads;
  if (u.rol !== 'asesor' && S.hoyAsesor) ls = ls.filter(l => norm(l.asesor) === norm(S.hoyAsesor));
  return ls;
}
/** «Mi pulso»: el mix completo (leads, cotizaciones, ventas, meta) al minuto, con mensajes que empujan a actuar. */
function cargarPulso() {
  if (S.pulBusy) return; S.pulBusy = true;
  const as = S.hoyAsesor || '';
  api('control', { dias: 30, asesor: as }).then(r => { S.pul = r; S.pulAs = as; S.pulErr = ''; S.pulT = Date.now(); })
    .catch(e => { S.pulErr = e.message; })
    .finally(() => { S.pulBusy = false; const c = $('#hoy-pulso'); if (S.view === 'hoy' && c) { c.innerHTML = pulsoHtml(); const b = $('#pulso-btn'); if (b && b.firstElementChild) b.firstElementChild.innerHTML = '⚡ Mi pulso comercial' + resumenPulso(); } });
}
/** Tarjeta del pulso que, al tocarla, filtra la lista que aparece debajo. */
function kpiF(clave, l, v, s, cls) { return `<div data-act="pulso-f" data-k="${clave}" title="Toca para ver la lista" style="cursor:pointer;border-radius:14px;${S.pulF === clave ? 'outline:3px solid #2563eb;' : ''}">${kpi(l, v, s, cls)}</div>`; }
function pulsoLista(r, kSel, accionFiltro) {
  const k = kSel || S.pulF; if (!k) return '';
  const L = r.lista || [], pill = t => `<span class="pill">${esc(t)}</span>`;
  const fl = { leads: l => !l.sala, nuevos: l => !l.sala && l.estado === 'Nuevo', cotizaciones: l => l.cotizado, entregadas: l => l.entregada, pendEntrega: l => l.pendEntrega, seguimientos: l => l.abierto && l.vencido, recuperar: l => l.recuperar,
    calientes: l => l.abierto && l.caliente, riesgo: l => l.abierto && (l.riesgo || l.vencido), negocio: l => l.abierto && l.valor > 0,
    cotvencidas: l => l.abierto && l.cotizado && l.vencido, negociacion: l => l.abierto && l.fase === 'Negociación', todas: l => l.abierto && l.asesor,
    sincontacto: l => l.abierto && l.sinContacto, sinsoporte: l => l.sinSoporte, reasignados: l => (l.reasignaciones || 0) > 0, ventas: l => l.estado === 'Cerrado ganado' };
  const titulo = { leads: '📥 Leads recibidos (digitales)', nuevos: '🆕 Leads nuevos', cotizaciones: '📝 Cotizaciones', ventas: '💰 Ventas facturadas del mes', entregadas: '🏍️ Motos entregadas', pendEntrega: '⏳ Pendientes de entrega', seguimientos: '⏰ Seguimientos vencidos', atender: '⚡ Acciones pendientes', recuperar: '♻️ Por recuperar',
    calientes: '🔥 Oportunidades calientes', riesgo: '🚨 En riesgo', negocio: '💰 Negocio en curso', cotvencidas: '📝 Cotizaciones con seguimiento vencido', negociacion: '🤝 En negociación', todas: '🎯 Todas las oportunidades abiertas',
    sincontacto: '⏳ Leads sin contactar', sinsoporte: '⚠️ Cotizados sin cotización en el CRM', reasignados: '🔁 Leads reasignados' }[k] || '';
  let filas = '', n = 0;
  if (k === 'atender') {
    const T = r.tareas || []; n = T.length;
    filas = T.slice(0, 80).map(t => `<div class="card" style="margin-bottom:6px;padding:8px 12px"><span class="pill ${t.prioridad <= 1 ? 'pill-bad' : t.prioridad === 2 ? 'pill-warn' : ''}">${esc(t.tarea)}</span> <b data-act="abrir" data-id="${esc(t.id_lead)}" style="cursor:pointer">${esc(t.nombre)}</b> <span class="muted small">· ${esc(t.producto || '')}${t.asesor ? ' · ' + esc(t.asesor) : ''}</span><div class="small">${esc(t.detalle || '')}</div></div>`).join('');
  } else if (fl[k]) {
    const R = L.filter(fl[k]); n = R.length;
    filas = R.slice(0, 80).map(l => `<div class="card" style="margin-bottom:6px;padding:8px 12px"><b data-act="abrir" data-id="${esc(l.id)}" style="cursor:pointer">${esc(l.nombre)}</b> <span class="muted small">· ${esc(l.producto || '')} · ${esc(l.sede || '')}${l.asesor ? ' · ' + esc(l.asesor) : ''}</span> ${pill(l.estado)}${l.fase && l.fase !== l.estado ? ' ' + pill(l.fase) : ''}${l.canal ? ' <span class="pill pill-info">' + esc(l.canal) + '</span>' : ''}${l.sinSoporte ? ' <span class="pill pill-warn">sin cotización en el CRM</span>' : ''}</div>`).join('');
  }
  return `<div style="margin:10px 0 0"><div class="row between wrap" style="margin-bottom:6px"><b>${titulo} <span class="pill">${n}</span></b><button class="btn btn-sm" data-act="${accionFiltro || 'pulso-f'}" data-k="${esc(k)}"><i class="ti ti-x"></i> Quitar filtro</button></div>${filas || '<p class="small muted">No hay registros para este filtro.</p>'}${n > 80 ? `<p class="tiny muted">Mostrando 80 de ${n}.</p>` : ''}</div>`;
}
function pulsoHtml() {
  const r = S.pul;
  if (!r || !r.kpis || S.pulAs !== (S.hoyAsesor || '')) { if (!S.pulBusy) cargarPulso(); return `<div class="notice" style="margin-bottom:10px"><i class="ti ti-loader"></i><div>⏳ ${S.pulErr ? esc(S.pulErr) : 'Cargando tus números en tiempo real…'}</div></div>`; }
  const k = r.kpis, conT = k.conTiempoContacto || 0, R = r.reasignaciones || { total: 0 };
  const tareas = (r.tareas || []).length, urgentes = (r.tareas || []).filter(t => t.prioridad <= 1).length;
  let msg;
  if (k.sinContacto) msg = `📥 ${k.sinContacto} lead${k.sinContacto > 1 ? 's' : ''} sin contactar: el primero que responde, vende 💪`;
  else if (urgentes) msg = `🔥 Tienes ${urgentes} ${urgentes > 1 ? 'gestiones URGENTES' : 'gestión URGENTE'}: cada minuto cuenta, ¡ataca ya!`;
  else if (k.cotizadosSinSoporte) msg = `⚠️ ${k.cotizadosSinSoporte} lead${k.cotizadosSinSoporte > 1 ? 's' : ''} cotizado${k.cotizadosSinSoporte > 1 ? 's' : ''} sin cotización en el CRM: regístrala o corrige el estado.`;
  else msg = '💪 Todo al día. Sigue contactando y cotizando a tiempo.';
  const hora = S.pulT ? new Date(S.pulT).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  return `<div class="card" style="margin-bottom:12px;padding:14px">
    <div class="row wrap" style="justify-content:space-between;gap:8px"><b>⚡ Mi pulso de leads</b><span class="tiny muted">🔄 Actualizado ${esc(hora)} · cada minuto</span></div>
    <div style="font-weight:600;margin:8px 0">${esc(msg)}</div>
    <div class="small" style="margin:0 0 10px;line-height:1.7">${[
      k.calientesSinGestion ? `🔥 <b>${k.calientesSinGestion}</b> lead${k.calientesSinGestion > 1 ? 's calientes' : ' caliente'} sin gestión` : '',
      k.cotizacionesVencidas ? `📝 <b>${k.cotizacionesVencidas}</b> cotizaci${k.cotizacionesVencidas > 1 ? 'ones' : 'ón'} con seguimiento vencido` : '',
      k.cotizadosSinSoporteVencidos ? `⚠️ <b>${k.cotizadosSinSoporteVencidos}</b> cotizado${k.cotizadosSinSoporteVencidos > 1 ? 's' : ''} sin cotización en el CRM fuera de plazo` : '',
      k.enRiesgo ? `⚠️ <b>${k.enRiesgo}</b> negociaci${k.enRiesgo > 1 ? 'ones' : 'ón'} en riesgo` : ''].filter(Boolean).map(x => `<span style="display:inline-block;margin-right:14px">${x}</span>`).join('') || '✅ Sin alertas críticas ahora mismo.'}</div>
    <div class="grid g-kpi">
      ${kpiF('leads', '📥 Leads recibidos', k.recibidos || 0, `🆕 ${k.nuevos || 0} nuevos · ✅ ${k.contactados || 0} contactados`)}
      ${kpiF('sincontacto', '⏳ Sin contactar', k.sinContacto || 0, 'esperan su primer contacto', k.sinContacto ? 'bad' : 'ok')}
      ${kpi('⚡ Contacto en 15 min', txtPct(pctDe(k.contactoEn15min || 0, conT)), `${k.contactoEn15min || 0} de ${conT} contactados`)}
      ${kpi('⏱️ Contacto en 2 h', txtPct(pctDe(k.contactoEn2h || 0, conT)), `1er contacto (mediana): ${txtT(k.mediana1raRespuestaH)}`)}
      ${kpiF('cotizaciones', '📝 Cotizados', k.cotizaciones || 0, `🤝 ${k.negociacionesActivas || 0} negociaciones activas`)}
      ${kpiF('sinsoporte', '⚠️ Cotizado sin soporte', k.cotizadosSinSoporte || 0, 'no aparecen en el CRM', k.cotizadosSinSoporte ? 'warn' : 'ok')}
      ${kpiF('seguimientos', '⏰ Seguimientos', k.seguimientosVencidos || 0, `vencidos · 🟢 ${k.seguimientosPendientes || 0} al día`, k.seguimientosVencidos ? 'bad' : 'ok')}
      ${kpiF('atender', '🔥 Por atender', tareas, `${urgentes} urgentes · ⚠️ ${k.enRiesgo || 0} en riesgo`, urgentes ? 'bad' : (tareas ? 'warn' : 'ok'))}
      ${kpiF('reasignados', '🔁 Reasignados', k.reasignados || 0, `${R.total || 0} reasignaciones`)}
      ${kpiF('ventas', '💰 Vendidos (Síntesis)', k.ventas || 0, `${txtPct(k.conversion)} de los leads`, k.ventas ? 'ok' : '')}
      ${kpiF('recuperar', '♻️ Por recuperar', k.porRecuperar || 0, `${k.perdidos || 0} perdidos · ⏸️ ${k.detenidos || 0} detenidos`)}
    </div>${pulsoLista(r)}</div>`;
}
/** Texto corto del botón del pulso: lo más urgente, visible aun con el panel cerrado. */
function resumenPulso() {
  const r = S.pul; if (!r || !r.kpis) return '';
  const k = r.kpis, urg = (r.tareas || []).filter(t => t.prioridad <= 1).length;
  return ` <span class="muted small" style="font-weight:400">${k.sinContacto ? '· ⏳ ' + k.sinContacto + ' sin contactar' : '· al día'}${k.cotizadosSinSoporte ? ' · ⚠️ ' + k.cotizadosSinSoporte + ' sin cotización CRM' : ''}${urg ? ' · 🔥 ' + urg + ' urgente' + (urg > 1 ? 's' : '') : ''}</span>`;
}
setInterval(() => { try { if (S && S.view === 'hoy' && !document.hidden && $('#hoy-pulso') && $('#sheet').hidden) cargarPulso(); } catch (e) { /* sin pulso */ } }, 60e3);
function vHoy() {
  const u = S.data.user, ls = leadsAlcance(), M = S.M;
  if (S.pul && Date.now() - (S.pulT || 0) > 60e3 && !S.pulBusy) setTimeout(cargarPulso, 0);
  const abiertos = ls.filter(l => !['Facturado', 'Perdido'].includes(l.estado));
  const grupos = [
    { t: 'SLA vencido', icon: 'ti-alarm', items: abiertos.filter(l => l.sla === 'bad'), cls: 'pill-bad' },
    { t: 'Cita de hoy', icon: 'ti-calendar-event', items: abiertos.filter(l => l.citaHoy && l.sla !== 'bad') },
    { t: 'Por vencer (1 h hábil sin contacto)', icon: 'ti-clock-exclamation', items: abiertos.filter(l => l.sla === 'warn' && !l.citaHoy) },
    { t: 'Cotizado sin avance', icon: 'ti-hourglass', items: abiertos.filter(l => l.cotSinAvance && !l.citaHoy) },
    { t: 'Leads nuevos', icon: 'ti-sparkles', items: abiertos.filter(l => l.sla === 'ok' && !l.citaHoy) },
    { t: 'Contactados sin cotizar', icon: 'ti-file-off', items: abiertos.filter(l => l.sinCotizar && !l.citaHoy) },
    { t: 'En gestión', icon: 'ti-progress', items: abiertos.filter(l => !l.citaHoy && !l.sla && !l.sinCotizar && !l.cotSinAvance && l.estado !== 'Nuevo') },
    { t: 'Sin fecha de asignación', icon: 'ti-help', items: abiertos.filter(l => l.estado === 'Nuevo' && l.hAsign === null && !l.citaHoy) }
  ];
  grupos.forEach(g => g.items.sort((a, b) => (b.hAsign || 0) - (a.hAsign || 0)));
  const vencidos = grupos[0].items.length;
  const alertas = M.alertasAbiertas.filter(a => ls.some(l => [String(l.raw.id_lead), String(l.raw.id_contacto)].includes(String(a.id_lead || a.id_contacto))));
  const avisos = [];
  if (!S.data.hojas.Gestion_Asesor) avisos.push('No existe la hoja Gestion_Asesor; no se pueden registrar gestiones.');
  if (u.rol === 'jefe') {
    const sinCed = M.personas.filter(p => p.rolApp && !cedulaDe(p)).map(p => p.nombre);
    if (sinCed.length) avisos.push(`En la hoja Equipo falta la cédula de: ${sinCed.join(', ')}. Sin cédula no pueden entrar.`);
  }
  const sinGestion = ls.filter(l => !l.g && l.raw.id_lead).length;
  if (sinGestion) avisos.push(`${sinGestion} lead(s) todavía no tienen asesor asignado: los atiende Mateo (el bot) hasta que estén listos para pasar a un asesor. No se pueden marcar hasta entonces.`);
  // Las tarjetas son botones: al pulsarlas la lista de abajo muestra solo esos leads (pulsa de nuevo para quitar el filtro)
  const idsAlerta = new Set(); alertas.forEach(a => [a.id_lead, a.id_contacto].forEach(x => { if (x) idsAlerta.add(String(x)); }));
  const FILT = {
    sla: { t: 'SLA vencido', icon: 'ti-alarm', items: grupos[0].items },
    citas: { t: 'Citas de hoy', icon: 'ti-calendar-event', items: abiertos.filter(l => l.citaHoy) },
    nuevos: { t: 'Leads nuevos sin contactar', icon: 'ti-sparkles', items: abiertos.filter(l => l.estado === 'Nuevo') },
    alertas: { t: 'Leads con alertas abiertas', icon: 'ti-bell-ringing', items: ls.filter(l => idsAlerta.has(String(l.raw.id_lead)) || idsAlerta.has(String(l.raw.id_contacto))) }
  };
  const kf = (k, html) => html.replace('<div class="kpi', `<div data-act="hoy-f" data-k="${k}" role="button" tabindex="0" title="Pulsa para ver solo estos leads" style="cursor:pointer;${S.hoyF === k ? 'outline:3px solid #0b2e6e;outline-offset:2px' : ''}" class="kpi`);
  const filtro = S.hoyF && FILT[S.hoyF] ? FILT[S.hoyF] : null;
  const listado = filtro
    ? `<div class="section-title"><i class="ti ${filtro.icon}"></i>${filtro.t}<span class="count">${filtro.items.length}</span><button class="btn btn-sm" data-act="hoy-f" data-k="${S.hoyF}" style="margin-left:auto"><i class="ti ti-x"></i> Quitar filtro</button></div>
       <div class="list">${filtro.items.slice().sort((a, b) => (b.hAsign || 0) - (a.hAsign || 0)).map(leadCard).join('') || empty('ti-mood-check', 'Ningún lead en esta categoría.')}</div>`
    : (grupos.filter(g => g.items.length).map(g => `<div class="section-title"><i class="ti ${g.icon}"></i>${g.t}<span class="count">${g.items.length}</span></div>
      <div class="list">${g.items.map(leadCard).join('')}</div>`).join('') || `<div style="margin-top:16px">${empty('ti-mood-check', 'No tienes leads pendientes. ¡Todo al día!')}</div>`);

  return `<div class="page-h"><div><h2>Hoy</h2><p class="muted small">${cap(fmtFecha(new Date(), false))} · ${abiertos.length} leads abiertos · plazos en horas hábiles</p></div>
    ${u.rol !== 'asesor' ? `<select class="sel" data-ch="hoyAsesor">${opts(M.asesores.filter(p => u.rol === 'jefe' || p.sedeCanon === u.sede).map(p => p.nombre), S.hoyAsesor, u.rol === 'jefe' ? 'Todos los asesores' : 'Todo mi punto')}</select>` : ''}</div>
    ${avisos.map(a => `<div class="notice" style="margin-bottom:8px"><i class="ti ti-info-circle"></i><div>${esc(a)}</div></div>`).join('')}
    ${u.rol === 'asesor' ? '' : `<button class="btn" id="pulso-btn" data-act="pulso-toggle" style="width:100%;justify-content:space-between;margin-bottom:10px;padding:12px 16px;font-weight:600"><span>⚡ Mi pulso comercial${resumenPulso()}</span><i class="ti ${S.pulAbierto ? 'ti-chevron-up' : 'ti-chevron-down'}"></i></button>
    <div id="hoy-pulso" ${S.pulAbierto ? '' : 'hidden'}>${pulsoHtml()}</div>`}
    <div class="grid g-kpi">
      ${kf('sla', kpi('SLA vencido', vencidos, `≥ ${M.cfg.sla_vencida_h} h hábiles sin contacto`, vencidos ? 'bad' : 'ok'))}
      ${kf('citas', kpi('Citas hoy', FILT.citas.items.length, ''))}
      ${kf('nuevos', kpi('Nuevos', FILT.nuevos.items.length, 'sin contactar'))}
      ${kf('alertas', kpi('Alertas abiertas', alertas.length, S.data.hojas.Alertas_Log ? 'toca para ver los leads' : 'falta la hoja Alertas_Log', alertas.length ? 'warn' : ''))}
    </div>
    ${listado}`;
}

// ── Detalle del lead ──────────────────────────────────────────────────────
function abrirSheet(html, modal) {
  const p = $('#sheet-panel');
  p.className = 'sheet-panel' + (modal ? ' modal' : '');
  p.innerHTML = html;
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}
function cerrarSheet() {
  $('#sheet').hidden = true; document.body.style.overflow = ''; S.leadAbierto = null;
  // En la bandeja de chats, el chat abierto sigue actualizándose al cerrar la ficha
  if (S.view === 'chats' && S.chatSel && $('#chat')) { S.leadAbierto = S.chatSel; cargarChat(S.chatSel); }
}
// Un modal abierto desde el detalle del lead vuelve al detalle al cerrarse.
function cerrarModal() { S._modalCancel = null; if (S.leadAbierto) abrirLead(S.leadAbierto); else cerrarSheet(); }

const PERFIL = [
  ['modelo_interes', 'Modelo de interés'], ['zona', 'Zona'], ['intencion_compra', 'Intención de compra'], ['moto_entrega', 'Moto para entregar'],
  ['forma_pago', 'Forma de pago'], ['cuota_aprox', 'Cuota aproximada'], ['tipo_consulta', 'Tipo de consulta'], ['producto_cotizado', 'Producto cotizado'],
  ['origen', 'Origen'], ['anuncio_origen', 'Anuncio'], ['etapa', 'Etapa (IA)'], ['comentario_cliente', 'Comentario del cliente'],
  ['cliente_respuesta_satisfaccion', 'Respuesta satisfacción'], ['telefono_contacto', 'Teléfono dicho en el chat']
];
function abrirLead(id) {
  const l = S.M.byId[id];
  if (!l) return;
  S.leadAbierto = id;
  const r = l.raw, g = l.g || {}, u = S.data.user, ed = puedeEditar(l);
  const perIA = ((S.data.fase2 || {}).perfiles || []).find(p => String(p.id_lead) === f2Key(l)) || {};
  const perfil = PERFIL.filter(([k]) => r[k] !== undefined && r[k] !== '').map(([k, t]) => `<dt>${t}</dt><dd>${esc(r[k])}</dd>`).join('')
    + [['uso_moto', 'Uso de la moto'], ['objecion_principal', 'Objeción principal'], ['siguiente_paso', 'Siguiente paso']].filter(([k]) => perIA[k]).map(([k, t]) => `<dt>${t}</dt><dd>${esc(perIA[k])}</dd>`).join('');
  const eventos = [];
  if (r.fecha_primer_contacto) eventos.push({ f: parseFecha(r.fecha_primer_contacto), t: 'Primer mensaje al bot' });
  if (l.asign) eventos.push({ f: l.asign, t: 'Asignado a ' + (l.asesor || '—') });
  (S.data.bitacora || []).filter(b => String(b.llave) === l.id || String(b.llave) === String(r.id_lead)).forEach(b =>
    eventos.push({ f: parseFecha(b.fecha_hora), t: `${b.campo}: ${b.valor_anterior || 'vacío'} → <b>${esc(b.valor_nuevo || 'vacío')}</b>`, s: b.usuario, html: true }));
  l.alertas.forEach(a => eventos.push({ f: parseFecha(a.fecha_hora), t: `Alerta ${a.tipo || ''} ${a.nivel ? '(' + a.nivel + ')' : ''}`, s: (a.destinatario || '') + (si(a.atendida) || a.fecha_atendida ? ' · atendida' : ''), al: true }));
  if (r.fecha_cierre) eventos.push({ f: parseFecha(r.fecha_cierre), t: 'Cierre' });
  eventos.sort((a, b) => (b.f || 0) - (a.f || 0));

  const asesores = S.M.asesores.filter(p => u.rol === 'jefe' || p.sedeCanon === u.sede);
  abrirSheet(`<div class="sheet-h"><div><h2>${esc(l.nombre)}</h2><div class="muted small">${esc(l.asesor || 'Sin asesor')} · ${esc(l.sede || 'Sin punto')} · ID ${esc(l.id)}</div></div>
      <button class="icon-btn" data-close><i class="ti ti-x"></i></button></div>
    <div class="sheet-b">
      <div class="row wrap">${pillEstado(l.estado)}${pillTemp(l.tempIA, 'IA: ')}${pillTemp(l.temp, 'Asesor: ')}
        ${l.hPrimera !== null ? `<span class="pill ${l.aTiempo ? 'pill-ok' : 'pill-bad'}">1ª respuesta: ${fmtHoras(l.hPrimera)}</span>` : l.estado === 'Nuevo' && l.hAsign !== null ? `<span class="pill pill-${l.sla === 'bad' ? 'bad' : l.sla === 'warn' ? 'warn' : 'ok'}">${fmtHoras(l.hAsign)} sin contacto</span>` : ''}</div>
      ${l.incons.length ? `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div><b>Inconsistencia</b><br>${l.incons.map(esc).join('<br>')}</div></div>` : ''}
      ${(() => {
        const canal = canalLead(l), refPor = String(r.referido_por || (/^referido:/i.test(String(r.origen || '')) ? String(r.origen).replace(/^referido:\s*/i, '') : '')).trim();
        return `<div class="card"><div class="row wrap"><b>Origen:</b> <span class="pill ${canal === 'Pauta redes sociales' ? 'pill-info' : canal === 'Referido' ? 'pill-ok' : ''}">${esc(canal)}</span>${r.anuncio_origen ? `<span class="small muted">· ${esc(r.anuncio_origen)}</span>` : ''}${refPor ? `<span class="small">· recomendado por <b>${esc(refPor)}</b></span>` : ''}</div>
          ${ed && !refPor ? `<div class="row" style="margin-top:8px;gap:6px"><input class="inp grow" id="ref-por" maxlength="60" placeholder="¿Quién lo recomendó? (nombre)"><button class="btn btn-sm" data-act="referido" data-id="${esc(l.id)}"><i class="ti ti-users-plus"></i> Marcar como referido</button></div>` : ''}</div>`;
      })()}
      <div class="card"><div class="row wrap">${contactoTxt(l)}<span class="grow"></span>${S.view !== 'chats' ? `<button class="btn btn-sm btn-wa" data-act="ir-chat" data-id="${esc(l.id)}"><i class="ti ti-messages"></i> Chat</button>` : ''}</div>
        ${l.cita ? `<p class="small" style="margin:8px 0 0"><i class="ti ti-calendar-event"></i> Cita: <b>${fmtFecha(l.cita, !!r.cita_hora)}</b></p>` : ''}</div>

      ${ed ? `<div class="card"><div class="card-h"><h3>Gestión</h3>${l.g ? `<span class="tiny muted">Últ. act. ${fmtFecha(l.ultimaAct)}</span>` : ''}</div>
        ${!l.g ? `<div class="notice"><i class="ti ti-info-circle"></i><div>n8n aún no creó la fila de este lead en Gestion_Asesor. Puedes cambiar la etiqueta, pero no la gestión.</div></div>` : `
        <div class="grid g2">
          <div><label class="f">Contactado</label><div class="row"><span class="pill ${l.contactado ? 'pill-ok' : ''}">${l.contactado ? 'Sí' + (l.contactadoEn ? ' · ' + fmtFecha(l.contactadoEn) : '') : 'No'}</span>${!l.contactado ? `<button class="btn btn-sm btn-dark" data-act="contactado" data-id="${esc(l.id)}">Marcar contactado</button>` : ''}</div></div>
          <div><label class="f">Cotizado</label><div class="row"><span class="pill ${l.cotizado ? 'pill-warn' : ''}">${l.cotizado ? 'Sí' : 'No'}</span>${!l.cotizado && !['Facturado', 'Perdido'].includes(l.estado) ? `<button class="btn btn-sm" data-act="cotizado" data-id="${esc(l.id)}">Marcar cotizado</button>` : ''}</div></div>
          <div><label class="f">Resultado</label><select class="sel w100" data-act-ch="resultado" data-id="${esc(l.id)}">${opts([{ v: '', t: 'En proceso' }, { v: 'ganado', t: 'Pasa a facturar' }, { v: 'perdido', t: 'Perdido' }, { v: 'retenido', t: 'Detenido' }], norm(g.resultado) === 'perdido' ? 'perdido' : /^(gan|por fac)/.test(norm(g.resultado)) ? 'ganado' : norm(g.resultado).startsWith('ret') ? 'retenido' : '')}</select></div>
          <div><label class="f">Motivo de pérdida</label><div class="row"><span class="small">${esc(g.motivo_perdida || '—')}</span></div></div>
        </div>
        <div style="margin-top:10px"><label class="f">Respuesta del cliente</label><textarea class="inp" id="resp-cli" maxlength="500" placeholder="¿Qué respondió el cliente?">${esc(g.respuesta_cliente || '')}</textarea>
          <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn btn-sm" data-act="respuesta" data-id="${esc(l.id)}">Guardar respuesta</button></div></div>`}
        <div style="margin-top:10px"><label class="f">Temperatura (decisión del asesor · la IA propone: ${esc(l.tempIA || 'sin etiqueta')})</label>
          <div class="tags">${TEMPS.map(t => `<button class="tag-btn t-${norm(t)} ${(l.temp || l.tempIA) === t ? 'on' : ''}" data-act="temp" data-v="${t}" data-id="${esc(l.id)}">${t}</button>`).join('')}</div></div>
        ${u.rol !== 'asesor' ? `<div style="margin-top:12px"><label class="f">Reasignar asesor</label><div class="row"><select class="sel grow" id="reasignar">${opts(asesores.map(p => p.nombre), l.asesor, '— Elegir —')}</select><button class="btn btn-sm" data-act="reasignar" data-id="${esc(l.id)}">Reasignar</button></div></div>` : ''}
      </div>` : ''}

      ${cardAvance(l, ed)}
      <div class="card" id="oport-cli"><h3 style="margin-bottom:8px">Oportunidades del cliente</h3><p class="small muted" style="margin:0"><i class="ti ti-loader-2 spin"></i> Cargando…</p></div>

      <div class="card" id="perfil-cot" style="display:none"></div>
      <div class="card"><h3 style="margin-bottom:8px">Perfil</h3>${perfil ? `<dl class="kv">${perfil}</dl>` : '<p class="muted small">El bot aún no ha capturado datos de perfil.</p>'}</div>
      <div class="card"><h3 style="margin-bottom:8px">Memoria de la IA</h3><p class="small" style="margin:0;white-space:pre-wrap">${esc(r.memoria_resumen || 'Sin resumen todavía.')}</p></div>
      <div class="card"><h3 style="margin-bottom:8px">Evidencia</h3>
        <h4 class="muted" style="margin:6px 0">Cotizaciones (${l.cot.length})</h4>
        ${l.cot.length ? l.cot.map(q => `<div class="small">${esc(q.id_cotizacion || '')} · ${esc(q.modelo || '')} · ${money(num(q.precio_cotizado))} · ${fmtFecha(parseFecha(q.fecha), false)} ${q.estado_cotizacion ? '· ' + esc(q.estado_cotizacion) : ''}</div>`).join('') : '<p class="small muted" style="margin:0">Sin cotización vinculada (se cruza por teléfono o id_contacto).</p>'}
        <h4 class="muted" style="margin:10px 0 6px">Facturas (${l.fac.length})</h4>
        ${!S.data.hojas.Facturas ? '<p class="small muted" style="margin:0">La hoja Facturas aún no existe (solicitud al Sheet).</p>' : l.fac.length ? l.fac.map(f => `<div class="small">${esc(f.id_factura || '')} · ${esc(f.modelo || '')} · ${money(num(f.valor))} · ${fmtFecha(parseFecha(f.fecha), false)}</div>`).join('') : '<p class="small muted" style="margin:0">Sin factura vinculada.</p>'}
      </div>
      <div class="card"><h3 style="margin-bottom:8px">Línea de tiempo</h3>${eventos.length ? `<ul class="timeline">${eventos.map(e => `<li class="${e.al ? 'al' : ''}">${e.html ? e.t : esc(e.t)}<small>${fmtFecha(e.f)}${e.s ? ' · ' + esc(e.s) : ''}</small></li>`).join('')}</ul>` : '<p class="small muted" style="margin:0">Sin eventos.</p>'}</div>
      ${S.view === 'chats' ? '' : `<div class="card"><div class="card-h"><h3>Chat con el cliente</h3><span class="tiny muted">Mismo número de WhatsApp del negocio</span></div>
        <div id="chat-estado" class="chat-estado"></div>
        <div id="chat" class="chat"><div class="muted small"><i class="ti ti-loader-2 spin"></i> Cargando…</div></div>
        <div id="chat-box"></div></div>`}
    </div>`);
  if (S.view !== 'chats') cargarChat(id, true);
  cargarOportunidadesCliente(l);
  cargarPerfilCotizacion(l);
}

// Perfil de crédito que el cliente llenó en el cotizador web (cédula, actividad, forma de pago, centrales de riesgo): solo lo ve quien atiende el lead
function cargarPerfilCotizacion(l) {
  api('perfilCotizacion', { id_lead: l.id }).then(r => {
    const c = $('#perfil-cot'); if (!c || S.leadAbierto !== l.id || !r || !r.perfil) return;
    const p = r.perfil, pago = { credito_directo: 'Crédito directo', credito_financiera: 'Crédito con financiera', contado: 'Contado' }[p.forma_pago] || '—';
    const rg = { no_reportado: 'No reportado', reportado: 'REPORTADO', paz_y_salvo: 'Paz y salvo / certificación al día' }[p.central_riesgo] || '—';
    c.style.display = '';
    c.innerHTML = `<h3 style="margin-bottom:8px">🗂️ Perfil para estudio de crédito <span class="tiny muted">cotizador web · ${esc(String(p.fecha).slice(0, 16))}</span></h3>
      <dl class="kv"><dt>Cédula</dt><dd>${esc(p.cedula || '—')}</dd><dt>Actividad económica</dt><dd>${esc(p.actividad || '—')}</dd><dt>Ciudad</dt><dd>${esc(p.ciudad || '—')}</dd>
      <dt>Forma de pago</dt><dd>${esc(pago)}</dd><dt>Centrales de riesgo</dt><dd><span class="pill ${p.central_riesgo === 'reportado' ? 'pill-bad' : p.central_riesgo ? 'pill-ok' : ''}">${esc(rg)}</span></dd>
      <dt>Moto cotizada</dt><dd>${esc(p.modelo || '—')}</dd>${p.cuota_inicial ? `<dt>Cuota inicial</dt><dd>${money(p.cuota_inicial)}</dd>` : ''}${p.cuota_mensual_estim ? `<dt>Cuota estimada</dt><dd>${money(p.cuota_mensual_estim)} a ${p.plazo_meses} meses${p.financiador ? ' · ' + esc(p.financiador) : ''}</dd>` : ''}</dl>
      <p class="tiny muted" style="margin:8px 0 0">Datos personales autorizados por el cliente para el estudio de crédito. Úsalos solo para ese fin.</p>`;
  }).catch(() => {});
}

// ── Avance de la venta: etapas del embudo, citas y encuestas del lead ──
function cardAvance(l, ed) {
  const F = S.data.fase2 || {}, k = f2Key(l);
  const et = (F.etapas || []).filter(e => String(e.id_lead) === k);
  const citas = (F.citas || []).filter(c => String(c.id_lead) === k).sort((a, b) => String(b.fecha + b.hora).localeCompare(String(a.fecha + a.hora)));
  const encs = (F.encuestas || []).filter(e => String(e.id_lead) === k);
  const alcanzadas = uniq(et.map(e => e.etapa));
  const pendientes = ETAPAS_MANUALES.filter(x => !alcanzadas.includes(x));
  const clsCita = { 'agendada': 'pill-info', 'asistió': 'pill-ok', 'no asistió': 'pill-bad', 'cancelada': '', 'reprogramada': '' };
  const hoy = ymd(new Date());
  return `<div class="card"><div class="card-h"><h3>Avance de la venta</h3></div>
    <div class="row wrap" style="gap:4px">${alcanzadas.length ? alcanzadas.map(x => { const e = et.filter(y => y.etapa === x).pop(); return `<span class="pill ${x === 'Perdido' || x === 'Crédito negado' || x === 'No asistió a la cita' ? 'pill-bad' : x === 'Facturado' || x === 'Entregado' ? 'pill-ok' : 'pill-info'}" title="${esc(fmtFecha(parseFecha(e.fecha)))}${e.por ? ' · ' + esc(e.por) : ''}">${esc(x)}</span>`; }).join('') : '<span class="small muted">Aún sin etapas registradas.</span>'}</div>
    ${ed && pendientes.length ? `<div class="row wrap" style="gap:6px;margin-top:8px">${pendientes.map(x => `<button class="btn btn-sm" data-act="etapa" data-id="${esc(l.id)}" data-v="${esc(x)}">+ ${esc(x)}</button>`).join('')}</div>` : ''}
    <h4 class="muted" style="margin:12px 0 6px">Citas (${citas.length})</h4>
    ${citas.length ? citas.map(c => `<div class="row wrap" style="gap:6px;margin-bottom:4px"><span class="small"><i class="ti ti-calendar-event"></i> <b>${esc(String(c.fecha).slice(0, 10))} ${esc(String(c.hora).slice(0, 5))}</b> · ${c.tipo === 'revision' ? '<b>Revisión técnica</b> · ' : ''}${esc(l.sede || '')}</span><span class="pill ${clsCita[c.estado] || ''}">${esc(c.estado)}</span>
      ${ed && c.estado === 'agendada' ? ['asistió', 'no asistió', 'cancelada'].map(s => `<button class="btn btn-sm" data-act="cita-estado" data-id="${esc(l.id)}" data-cita="${esc(c.id_cita)}" data-v="${s}">${s === 'asistió' ? 'Asistió' : s === 'no asistió' ? 'No asistió' : 'Cancelar'}</button>`).join('') : ''}</div>`).join('') : '<p class="small muted" style="margin:0">Sin citas registradas.</p>'}
    ${(S.data.user.rol === 'jefe' || S.data.user.rol === 'admin') && l.estado !== 'Perdido' ? reasignarHtml(l) : ''}
    ${ed && l.estado !== 'Perdido' ? `<div class="row wrap" style="gap:6px;margin-top:10px"><button class="btn btn-sm" data-act="prox-abrir" data-id="${esc(l.id)}"><i class="ti ti-calendar-time"></i> Programar próxima acción</button><span class="tiny muted">Si no la cumples: alerta → recordatorio → escalamiento al administrador.</span></div>` : ''}
    ${ed ? `<div class="row wrap" style="gap:6px;margin-top:8px"><input class="inp" type="date" id="cita-f" min="${hoy}" style="max-width:160px"><input class="inp" type="time" id="cita-h" style="max-width:120px"><button class="btn btn-sm btn-dark" data-act="cita-nueva" data-id="${esc(l.id)}"><i class="ti ti-calendar-plus"></i> Agendar cita</button></div>
      <p class="tiny muted" style="margin:6px 0 0">Al agendar, el cliente recibe recordatorio 24 h y 2 h antes, y tú 2 h antes.</p>` : ''}
    ${ed && l.cerrado ? `<div class="row wrap" style="gap:6px;margin-top:12px"><button class="btn btn-sm btn-dark" data-act="entrega-moto" data-id="${esc(l.id)}"><i class="ti ti-motorbike"></i> Moto entregada</button><span class="tiny muted">También se marca sola cuando la factura sale del inventario.</span></div>
      <h4 class="muted" style="margin:12px 0 6px"><i class="ti ti-tool"></i> Revisión técnica</h4>
      <p class="small" style="margin:0 0 6px">Venta cerrada ✔ Agenda la primera revisión técnica de la moto; el cliente recibe recordatorio.</p>
      <div class="row wrap" style="gap:6px"><input class="inp" type="date" id="rev-f" min="${hoy}" style="max-width:160px"><input class="inp" type="time" id="rev-h" style="max-width:120px"><button class="btn btn-sm btn-dark" data-act="cita-revision" data-id="${esc(l.id)}"><i class="ti ti-tool"></i> Agendar revisión técnica</button></div>` : ''}
    ${encs.length ? `<h4 class="muted" style="margin:12px 0 6px">Encuestas</h4>${encs.map(e => `<div class="small">${e.tipo === 'nps' ? 'NPS' : '¿Por qué no compró?'} · ${e.respondida ? (e.tipo === 'nps' ? `nota <b>${esc(e.nota)}</b> (${esc(e.clasificacion)})` : `<b>${esc(e.motivo)}</b>`) : esc(e.estado)}</div>`).join('')}` : ''}
  </div>`;
}
async function accionAvance(act, a) {
  const l = S.M.byId[a.dataset.id]; if (!l) return;
  a.disabled = true;
  try {
    if (act === 'etapa') { await api('etapa', { id_lead: l.id, etapa: a.dataset.v }); toast('Etapa registrada: ' + a.dataset.v, 'ok'); }
    if (act === 'cita-estado') { await api('cita', { id_lead: l.id, id_cita: a.dataset.cita, estado: a.dataset.v }); toast('Cita: ' + a.dataset.v, 'ok'); }
    if (act === 'cita-nueva') {
      const f = $('#cita-f').value, h = $('#cita-h').value;
      if (!f || !h) { toast('Elige el día y la hora de la cita.', 'bad'); a.disabled = false; return; }
      await api('cita', { id_lead: l.id, fecha: f, hora: h }); toast('Cita agendada', 'ok');
    }
    if (act === 'entrega-moto') {
      const r = await api('entrega', { id_lead: l.id }); toast(r && r.ya ? 'La entrega ya estaba registrada' : 'Entrega registrada. Ahora agenda la revisión técnica.', 'ok');
    }
    if (act === 'cita-revision') {
      const f = $('#rev-f').value, h = $('#rev-h').value;
      if (!f || !h) { toast('Elige el día y la hora de la revisión técnica.', 'bad'); a.disabled = false; return; }
      await api('cita', { id_lead: l.id, fecha: f, hora: h, tipo: 'revision' }); toast('Revisión técnica agendada', 'ok');
    }
    await recargarLead();
  } catch (e) { toast(e.message, 'bad'); a.disabled = false; }
}

// Un cliente = un contacto; sus cotizaciones y ventas son oportunidades distintas (historial sin duplicar al cliente)
function cargarOportunidadesCliente(l) {
  api('oportunidades', { id_lead: l.id }).then(r => {
    const c = $('#oport-cli'); if (!c || S.leadAbierto !== l.id) return;
    const cls = { Facturado: 'pill-ok', Perdida: 'pill-bad', Cotizado: 'pill-warn' };
    c.innerHTML = `<h3 style="margin-bottom:8px">Oportunidades del cliente <span class="pill">${(r.oportunidades || []).length}</span></h3>` + ((r.oportunidades || []).length
      ? (r.oportunidades || []).map(o => `<div class="row wrap small" style="gap:6px;margin-bottom:4px"><span class="muted">${esc(o.fecha)}</span><b>${esc(o.modelo || '—')}</b><span class="pill ${cls[o.estado] || ''}">${esc(o.estado)}</span><span class="tiny muted">cotización ${esc(o.id)}${o.factura ? ' · factura ' + esc(o.factura) : ''}${o.origen === 'VENTA EN SALA' ? ' · venta en sala' : ''}</span></div>`).join('')
      : '<p class="small muted" style="margin:0">Sin cotizaciones ni ventas registradas todavía para este cliente.</p>')
      + ((r.timeline || []).length ? `<details style="margin-top:10px"><summary class="small" style="cursor:pointer"><b>🕒 Línea de tiempo (${r.timeline.length})</b></summary>${r.timeline.map(e => `<div class="small" style="margin:4px 0;padding-left:8px;border-left:2px solid var(--line,#ccc)"><span class="muted">${esc(String(e.f).slice(0, 16))}</span> · <b>${esc(e.t)}</b>${e.d ? ' · ' + esc(e.d) : ''}${e.por ? `<span class="tiny muted"> · ${esc(e.por)}</span>` : ''}</div>`).join('')}</details>` : '');
  }).catch(() => { const c = $('#oport-cli'); if (c) c.remove(); });
}

// ── Centro de control comercial: tareas, supervisión, conversión, recuperación, alertas y auditoría ──
const ACCIONES_PROX = ['Llamar', 'Escribir por WhatsApp', 'Enviar cotización', 'Agendar visita', 'Esperar respuesta de crédito', 'Cierre y facturación', 'Otra'];
function cargarControl() {
  if (S.ctlBusy) return; S.ctlBusy = true;
  api('control', { dias: S.ctlDias || 30 }).then(r => { S.ctl = r; S.ctlErr = ''; S.ctlT = Date.now(); })
    .catch(e => { S.ctlErr = e.message; })
    .finally(() => { S.ctlBusy = false; if (S.view === 'control') { const c = $('#ctl-cuerpo'); if (c) c.innerHTML = cuerpoControl(); } });
}
function vControl() {
  if (!S.ctl || Date.now() - (S.ctlT || 0) > 60000) cargarControl();
  const tabs = [['tareas', 'Mis tareas'], ['supervision', 'Supervisión'], ['conversion', 'Conversión'], ['recuperacion', 'Recuperación'], ['alertas', 'Alertas'], ['auditoria', 'Auditoría'], ['piloto', 'Piloto']];
  const tab = S.ctlTab || 'tareas';
  return `<div class="page-h"><div><h2>Centro de control comercial</h2><p class="muted small">Qué pasa con cada lead, qué debe hacer cada asesor ahora y dónde se está perdiendo la venta. ${S.data.user.rol === 'asesor' ? 'Solo tus oportunidades.' : ''}</p></div>
    <div class="row"><select class="sel" id="ctl-dias">${opts([{ v: '7', t: 'Últimos 7 días' }, { v: '30', t: 'Últimos 30 días' }, { v: '90', t: 'Últimos 90 días' }, { v: '0', t: 'Todo' }], String(S.ctlDias === undefined ? 30 : S.ctlDias))}</select>
    <button class="btn btn-sm" data-act="ctl-recargar"><i class="ti ti-refresh"></i> Actualizar</button></div></div>
    <div class="seg" style="margin-bottom:12px">${tabs.map(t => `<button class="${tab === t[0] ? 'on' : ''}" data-tab="ctlTab" data-v="${t[0]}">${t[1]}</button>`).join('')}</div>
    <div id="ctl-cuerpo">${cuerpoControl()}</div>`;
}
function cuerpoControl() {
  const r = S.ctl;
  if (!r) return S.ctlErr ? `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div>${esc(S.ctlErr)}</div></div>` : '<div class="loading"><div><i class="ti ti-loader-2 spin"></i> Calculando el centro de control…</div></div>';
  const k = r.kpis || {}, p = r.presupuesto || {}, f = r.pronostico || {};
  const num = v => v === null || v === undefined ? '—' : v;
  const kpis = `<div class="grid g-kpi">${kpi('Leads recibidos', k.recibidos || 0, `${k.nuevos || 0} nuevos · ${k.asignados || 0} asignados`)}
    ${kpi('Sin contacto', k.sinContacto || 0, 'Leads que nadie ha contactado', k.sinContacto ? 'warn' : '')}
    ${kpi('Abandonados', k.abandonados || 0, `${DIAS_ABANDONO_UI}+ días sin actividad`, k.abandonados ? 'warn' : '')}
    ${kpi('Seguimientos vencidos', k.seguimientosVencidos || 0, `${k.seguimientosPendientes || 0} pendientes al día`, k.seguimientosVencidos ? 'warn' : '')}
    ${kpi('1ª respuesta (mediana)', k.mediana1raRespuestaH === null || k.mediana1raRespuestaH === undefined ? '—' : fmtHoras(k.mediana1raRespuestaH), `${k.contactosRealizados || 0} contactos registrados`)}
    ${kpi('Negociaciones activas', k.negociacionesActivas || 0, `${k.cotizaciones || 0} cotizaciones · ${k.financiacion || 0} con financiación`)}
    ${kpi('En riesgo', k.enRiesgo || 0, 'Clientes que se enfrían', k.enRiesgo ? 'warn' : '')}
    ${kpi('Por recuperar', k.porRecuperar || 0, 'Oportunidades rescatables')}</div>
    <div class="grid g-kpi" style="margin-top:12px">${kpi('Lead → oportunidad', k.leadAOportunidad === null || k.leadAOportunidad === undefined ? '—' : k.leadAOportunidad + ' %', `${k.oportunidades || 0} oportunidades`)}
    ${kpi('Oportunidad → venta', k.oportunidadAVenta === null || k.oportunidadAVenta === undefined ? '—' : k.oportunidadAVenta + ' %', `${k.ventas || 0} ventas`)}
    ${kpi('Conversión total', k.conversion === null || k.conversion === undefined ? '—' : k.conversion + ' %', `${k.perdidos || 0} perdidos · ${k.detenidos || 0} detenidos`)}
    ${kpi('Cotizado sin soporte', k.cotizadosSinSoporte || 0, `${k.cotizadosSinSoporteVencidos || 0} fuera de plazo (no aparecen en el CRM)`, k.cotizadosSinSoporte ? 'warn' : 'ok')}
    ${kpi('Contacto en 15 min', txtPct(pctDe(k.contactoEn15min || 0, k.conTiempoContacto || 0)), `${k.contactoEn15min || 0} de ${k.conTiempoContacto || 0} contactados`)}
    ${kpi('Contacto en 2 h', txtPct(pctDe(k.contactoEn2h || 0, k.conTiempoContacto || 0)), `${k.contactoEn2h || 0} de ${k.conTiempoContacto || 0} contactados`)}</div>
    <div class="grid g-kpi" style="margin-top:12px">${['Pauta redes sociales', 'Referido', 'Orgánico', 'Cotizador web'].map(o => kpi(o === 'Pauta redes sociales' ? 'Pauta en redes' : o, (k.porOrigen || {})[o] || 0, 'leads de este origen')).join('')}
    ${kpi('Reasignados', k.reasignados || 0, 'leads que cambiaron de asesor')}
    ${kpi('Vendidos', k.facturaciones || 0, 'Cerrado ganado (cruzado con Síntesis)')}
    ${kpi('Pasan a facturar', k.porFacturar || 0, 'Esperando que cargue en Síntesis')}
    ${kpi('Oportunidades activas', k.activas || 0, 'Leads en gestión')}
    ${kpi('Recuperadas', k.recuperadas || 0, `${k.perdidos || 0} perdidas · ${k.detenidos || 0} detenidas`)}</div>`;
  const tab = S.ctlTab || 'tareas';
  const cuerpo = { tareas: ctlTareas, supervision: ctlSupervision, conversion: ctlConversion, recuperacion: ctlRecuperacion, alertas: ctlAlertas, auditoria: ctlAuditoria, piloto: ctlPiloto }[tab](r);
  return kpis + `<div style="margin-top:14px">${cuerpo}</div>`;
}
const DIAS_ABANDONO_UI = 5;
function ctlTareas(r) {
  const u = S.data.user, asesores = uniq((r.tareas || []).map(t => t.asesor).filter(Boolean)).sort();
  const sel = S.ctlAsesor || (u.rol === 'asesor' ? u.nombre : '');
  const ts = (r.tareas || []).filter(t => !sel || norm(t.asesor) === norm(sel));
  const colores = { 1: 'pill-bad', 2: 'pill-warn', 3: 'pill-info', 4: '' };
  return `<div class="row between wrap" style="margin-bottom:8px"><h3>Bandeja de tareas <span class="pill">${ts.length}</span></h3>
    ${u.rol !== 'asesor' ? `<select class="sel" data-ch="ctlAsesor">${opts(asesores, sel, 'Todo el equipo')}</select>` : ''}</div>
    ${ts.length ? ts.slice(0, 80).map(t => `<div class="card" style="margin-bottom:8px;padding:10px 12px"><div class="row between wrap" style="gap:8px"><div>
      <span class="pill ${colores[t.prioridad] || ''}">${esc(t.tarea)}</span> <b data-act="abrir" data-id="${esc(t.id_lead)}" style="cursor:pointer">${esc(t.nombre)}</b> <span class="muted small">· ${esc(t.producto || '')}${t.asesor ? ' · ' + esc(t.asesor) : ''}</span>
      <div class="small" style="margin-top:4px">${esc(t.detalle || '')}</div>
      ${t.ia ? `<div class="small" style="margin-top:3px"><b>🤖 IA:</b> ${esc(t.ia)}</div>` : ''}${t.porque && t.porque.length ? `<div class="tiny muted">Por qué: ${esc(t.porque.join(' · '))}${t.fase ? ' · fase ' + esc(t.fase) : ''}</div>` : ''}</div>
      <div class="row" style="gap:6px"><span class="tiny muted" title="Puntaje del lead">★ ${t.score}</span><button class="btn btn-sm" data-act="abrir" data-id="${esc(t.id_lead)}">Abrir</button>${t.pv ? `<button class="btn btn-sm btn-dark" data-act="pv-hecho" data-id="${esc(t.id_lead)}" data-tipo="${esc(t.pv)}"><i class="ti ti-check"></i> Hecho</button>` : `<button class="btn btn-sm btn-dark" data-act="prox-abrir" data-id="${esc(t.id_lead)}"><i class="ti ti-calendar-time"></i> Programar acción</button>`}</div></div></div>`).join('') : empty('ti-checks', 'Sin tareas pendientes. Buen trabajo.')}`;
}
function ctlSupervision(r) {
  const fila = a => { const sem = a.vencidos >= 3 || a.sinContacto >= 3 ? 'pill-bad' : (a.vencidos || a.sinContacto ? 'pill-warn' : 'pill-ok'); return `<tr><td>${esc(a.k)}</td><td class="r">${a.leads}</td><td class="r">${a.sinContacto}</td><td class="r">${pct(a.contactados, a.leads) === null ? '—' : pct(a.contactados, a.leads) + ' %'}</td><td class="r">${a.tResp === null || a.tResp === undefined ? '—' : fmtHoras(a.tResp)}</td><td class="r"><span class="pill ${sem}">${a.vencidos}</span></td><td class="r">${a.abandonados}</td><td class="r">${a.oportunidades}</td><td class="r">${a.ventas}</td><td class="r">${a.entregadas || 0}</td><td class="r">${a.conv} %</td></tr>`; };
  return `<h3 style="margin-bottom:8px">Cumplimiento por asesor</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Asesor</th><th class="r">Leads</th><th class="r">Sin contacto</th><th class="r">Contactados</th><th class="r">1ª resp.</th><th class="r">Seg. vencidos</th><th class="r">Abandonados</th><th class="r">Oportunidades</th><th class="r">Ventas</th><th class="r">Entregadas</th><th class="r">Conversión</th></tr></thead><tbody>${(r.asesores || []).map(fila).join('') || '<tr><td colspan="11" class="muted">Sin datos.</td></tr>'}</tbody></table></div>
    <p class="tiny muted" style="margin:8px 0 0">Escalera automática: alerta a los 15 min (lead nuevo) → recordatorio → escalamiento al administrador → reasignación. Los seguimientos vencidos son los que superaron su plazo o la próxima acción programada.</p>`;
}
/** Cadena de mando: el Jefe reasigna; el administrador solo SOLICITA la reasignación (el Jefe decide); el asesor no puede. */
function reasignarHtml(l) {
  const u = S.data.user, jefe = u.rol === 'jefe';
  const team = (S.M.asesores || []).filter(p => (jefe || p.sedeCanon === u.sede) && norm(p.nombre) !== norm(l.asesor || '')).map(p => p.nombre);
  return `<div class="card" style="margin-top:10px;padding:10px 12px"><h4 class="muted" style="margin:0 0 6px"><i class="ti ti-arrows-exchange"></i> ${jefe ? 'Reasignar lead (solo Jefe)' : 'Solicitar reasignación al Jefe'}</h4>
    <div class="row wrap" style="gap:6px"><select class="sel" id="reas-as">${opts(team, '', jefe ? 'Nuevo asesor…' : 'Asesor sugerido…')}</select><input class="inp" id="reas-mot" placeholder="Motivo (obligatorio)" style="flex:1;min-width:180px"><button class="btn btn-sm btn-dark" data-act="reasignar" data-id="${esc(l.id)}">${jefe ? 'Reasignar' : 'Solicitar'}</button></div>
    <p class="tiny muted" style="margin:6px 0 0">${jefe ? 'Queda auditado: quién, cuándo, de quién a quién y por qué.' : 'El administrador acompaña con notas y seguimientos, pero el dueño del lead lo cambia solo el Jefe.'}</p></div>`;
}
/** Panel del piloto: qué medir durante la prueba real (atención, conversión por etapa, facturadas sin entrega, ritmo por sede, integridad de datos). */
function cargarPiloto() {
  if (S.pilBusy) return; S.pilBusy = true;
  api('piloto', { dias: S.pilDias || 7 }).then(r => { S.pil = r; S.pilErr = ''; S.pilT = Date.now(); })
    .catch(e => { S.pilErr = e.message; })
    .finally(() => { S.pilBusy = false; if (S.view === 'control' && (S.ctlTab || 'tareas') === 'piloto') { const c = $('#ctl-cuerpo'); if (c) c.innerHTML = cuerpoControl(); } });
}
/** Ventas del mes cuyo asesor aún no se ha validado a mano (facturación puede equivocarse de asesor; la venta siempre cuenta para el punto). */
function ventasValidarHtml(r) {
  const u = S.data.user; if (u.rol !== 'jefe' && u.rol !== 'admin') return '';
  const V = r.ventasPorValidar || [], team = (S.M.asesores || []).filter(p => u.rol === 'jefe' || p.sedeCanon === u.sede);
  return `<h3 style="margin:16px 0 8px">✅ Validar asesor de las ventas del mes <span class="pill ${V.length ? 'pill-warn' : 'pill-ok'}">${V.length}</span></h3>
    <p class="small muted" style="margin:0 0 8px">Cada venta cuenta siempre para el <b>punto</b> de donde sale la moto. El asesor que puso facturación se confirma o se corrige aquí: de eso dependen las metas y comisiones por asesor.</p>
    ${V.length ? V.map(o => { const sug = (S.M.asesores || []).find(p => mismaPersona(p.nombre, o.asesor)); return `<div class="card" style="margin-bottom:6px;padding:8px 12px"><div class="row between wrap" style="gap:8px"><div><b>${esc(o.cliente || 'Cliente')}</b> <span class="muted small">· ${esc(o.modelo)} · factura ${esc(o.factura)} · ${esc(o.sede)} · ${esc(o.fecha)} · ${money(num(o.valor))}</span> <span class="pill ${o.enEquipo ? '' : 'pill-warn'}">facturó: ${esc(o.asesor || '—')}${o.enEquipo ? '' : ' (no es de tu equipo)'}</span></div>
      <div class="row" style="gap:6px"><select class="sel" id="val-as-${esc(o.factura)}">${opts(team.map(p => p.nombre), sug && team.some(p => p.nombre === sug.nombre) ? sug.nombre : '', 'Asesor…')}</select><button class="btn btn-sm btn-dark" data-act="val-venta" data-id="${esc(o.factura)}">Confirmar</button></div></div></div>`; }).join('') : '<p class="small muted">Todas las ventas del mes tienen asesor validado ✅</p>'}`;
}
/** Cola «Por revisar» (solo Jefe): cotizaciones y ventas de otra zona o de asesores que no están en Equipo. No cuentan en los indicadores hasta que se decida a mano. */
function porRevisarHtml(r) {
  const L = r.porRevisar || []; if (!r.esJefe) return '';
  const asesores = (S.M.asesores || []).map(p => p.nombre);
  return `<h3 style="margin:16px 0 8px">🧐 Por revisar a mano <span class="pill ${L.length ? 'pill-warn' : 'pill-ok'}">${L.length}</span></h3>
    <p class="small muted" style="margin:0 0 8px">Cotizaciones y ventas que llegaron del CRM o de Síntesis pero son de otra zona o de un asesor que no está en tu equipo. No se cuentan hasta que decidas: así no se pierde ninguna venta.</p>
    ${L.length ? L.map(o => `<div class="card" style="margin-bottom:6px;padding:8px 12px"><div class="row between wrap" style="gap:8px"><div><b>${esc(o.cliente || 'Cliente')}</b> <span class="muted small">· ${esc(o.modelo)} · ${esc(o.fecha)} · asesor «${esc(o.asesor)}» · ${esc(o.sede || 'sin sede')}</span> <span class="pill ${o.estado === 'Facturado' ? 'pill-ok' : ''}">${esc(o.estado)}${o.factura ? ' · ' + esc(o.factura) : ''}</span></div>
      <div class="row" style="gap:6px"><select class="sel" id="rev-as-${esc(o.id)}">${opts(asesores, '', 'Asignar a…')}</select><button class="btn btn-sm btn-dark" data-act="rev-asignar" data-id="${esc(o.id)}">Asignar</button><button class="btn btn-sm" data-act="rev-descartar" data-id="${esc(o.id)}" title="No es de mi equipo">No es mío</button></div></div></div>`).join('') : '<p class="small muted">Nada por revisar ✅</p>'}`;
}
/** Pronóstico del mes en tres escenarios, contra la meta y contra el ritmo del mes anterior. */
function pronosticoHtml(r) {
  const f = r.pronostico, p = r.presupuesto; if (!f || !f.escenarios) return '';
  const e = f.escenarios, m = f.mesAnterior || {}, meta = f.meta;
  return `<h3 style="margin:16px 0 8px">🔮 Pronóstico del mes</h3>
    <div class="grid g-kpi">${kpi('🔻 Bajo', e.bajo, 'solo lo ya facturado')}
    ${kpi('🎯 Esperado', e.medio, meta ? `${f.cumplimientoProyectado} % de la meta de ${meta}` : 'sin meta cargada', meta && e.medio >= meta ? 'ok' : 'warn')}
    ${kpi('🚀 Alto', e.alto, 'si el pipeline rinde 50 % más')}
    ${kpi('📆 vs mes anterior', m.diferencia === null || m.diferencia === undefined ? '—' : (m.diferencia > 0 ? '+' : '') + m.diferencia, m.ventas ? `${m.ventas} ventas en ${m.mes}; a hoy se esperaban ${m.esperadoAHoy}` : 'sin ventas del mes anterior', m.diferencia < 0 ? 'bad' : 'ok')}</div>
    ${p && p.meta ? `<p class="small" style="margin:6px 0 0">${p.brecha > 0 ? `Faltan <b>${p.brecha}</b> motos para la meta: hacen falta <b>${p.cierresDiarios}</b> cierres por día durante ${p.diasRestantes} días.` : '🏆 La meta del mes ya está cumplida.'}</p>` : ''}`;
}
function ctlPiloto() {
  if (!S.pil || Date.now() - (S.pilT || 0) > 60000) cargarPiloto();
  const r = S.pil;
  if (!r) return S.pilErr ? `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div>${esc(S.pilErr)}</div></div>` : '<div class="loading"><div><i class="ti ti-loader-2 spin"></i> Midiendo el piloto…</div></div>';
  const k = r.kpis || {}, i = r.integridad || {}, malos = Object.values(i).reduce((a, b) => a + (b || 0), 0);
  const nom = { idLeadDuplicados: 'id_lead repetidos', telefonosDuplicados: 'Teléfonos repetidos', leadsConVariasGestiones: 'Leads con varias filas de gestión', leadsSinGestion: 'Leads sin fila de gestión', leadsSinAsesor: 'Leads abiertos sin asesor', cotizacionesDuplicadas: 'Cotizaciones duplicadas', facturasSinLead: 'Facturas sin lead asociado' };
  return `<div class="row between wrap" style="margin-bottom:8px"><h3>🔥 Piloto real · últimos ${r.dias} días</h3><select class="sel" id="pil-dias">${opts([{ v: '7', t: '7 días' }, { v: '14', t: '14 días' }, { v: '30', t: '30 días' }], String(S.pilDias || 7))}</select></div>
    <div class="grid g-kpi">${kpi('📥 Leads recibidos', k.recibidos || 0, `✅ ${k.atendidos || 0} atendidos · ⏳ ${k.sinContacto || 0} sin contacto`)}
    ${kpi('⏱️ 1ª respuesta', k.mediana1raRespuestaH === null || k.mediana1raRespuestaH === undefined ? '—' : fmtHoras(k.mediana1raRespuestaH), 'mediana', '')}
    ${kpi('🔁 Reasignaciones', k.reasignaciones === undefined ? '—' : k.reasignaciones, 'acumuladas')}
    ${kpi('📝 Cotizaciones', k.cotizaciones || 0, `🏬 ${k.ventasSala || 0} ventas en sala`)}
    ${kpi('🧾 Facturados', k.facturados || 0, 'últimos 45 días', 'ok')}
    ${kpi('🏍️ Entregados', k.entregados || 0, `🔴 ${k.pendientesEntrega || 0} sin entregar`, k.pendientesEntrega ? 'warn' : 'ok')}
    ${kpi('❌ Perdidos', k.perdidos || 0, 'con motivo obligatorio')}
    ${kpi('⏰ Seg. vencidos', k.seguimientosVencidos || 0, 'fuera de plazo', k.seguimientosVencidos ? 'bad' : 'ok')}</div>
    <h3 style="margin:16px 0 8px">Conversión por etapa</h3>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Paso</th><th class="r">Entran</th><th class="r">Pasan</th><th class="r">%</th></tr></thead><tbody>${(r.conversion || []).map(c => `<tr><td>${esc(c.etapa)}</td><td class="r">${c.de || 0}</td><td class="r">${c.a || 0}</td><td class="r"><b>${c.pct === null ? '—' : c.pct + ' %'}</b></td></tr>`).join('')}</tbody></table></div>
    <h3 style="margin:16px 0 8px">Integridad de los datos <span class="pill ${malos ? 'pill-warn' : 'pill-ok'}">${malos ? malos + ' por revisar' : 'limpio'}</span></h3>
    <div class="tbl-wrap"><table class="tbl"><tbody>${Object.keys(nom).map(x => `<tr><td>${nom[x]}</td><td class="r"><span class="pill ${i[x] ? 'pill-warn' : 'pill-ok'}">${i[x] || 0}</span></td></tr>`).join('')}</tbody></table></div>
    ${r.esJefe && (r.trazabilidad || []).length ? `<h3 style="margin:16px 0 8px">🔗 Trazabilidad (solo Jefe): cliente → factura → modelo → chasis → entrega</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Cliente</th><th>Factura</th><th>Modelo</th><th>Chasis</th><th>Sede</th><th>Entrega</th></tr></thead><tbody>${r.trazabilidad.map(t => `<tr><td>${esc(t.cliente)}</td><td>${esc(t.factura)}</td><td>${esc(t.modelo)}</td><td>${esc(t.chasis || '—')}</td><td>${esc(t.sede)}</td><td>${esc(t.entrega)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <p class="tiny muted" style="margin-top:10px">Regla de desarrollo: toda función nueva debe ayudar a captar, convertir, controlar o recuperar.</p>`;
}
/** Lectura de la IA: frases claras para gerencia a partir de los números (motivos de pérdida, actividad vs resultado, embudo). */
function lecturaIA(r) {
  const k = r.kpis || {}, out = [];
  const ps = k.perdidasSede || {};
  Object.keys(ps).forEach(sede => {
    const tot = Object.values(ps[sede]).reduce((a, b) => a + b, 0); if (tot < 3) return;
    const [m, n] = Object.entries(ps[sede]).sort((a, b) => b[1] - a[1])[0];
    out.push(`📉 En ${sede}, el principal motivo de pérdida es «${m}»: ${Math.round(n * 100 / tot)} % de las ${tot} oportunidades perdidas.`);
  });
  (r.asesores || []).filter(a => a.k !== 'Sin asesor').forEach(a => {
    if (a.cotizaciones >= 5 && a.convCot !== null && a.convCot < 10 && a.seguimientos >= 10) out.push(`🔎 ${a.k} cotiza (${a.cotizaciones}) y gestiona (${a.seguimientos} seguimientos) pero solo cierra el ${a.convCot} %: revisar objeciones y proceso de cierre.`);
    if (a.leads >= 5 && a.sinContacto >= Math.ceil(a.leads * 0.3)) out.push(`⏰ ${a.k} tiene ${a.sinContacto} de ${a.leads} leads sin contactar: acompañar y reforzar la velocidad de respuesta.`);
    if (a.vencidos >= 3) out.push(`🚨 ${a.k} acumula ${a.vencidos} seguimientos vencidos.`);
  });
  const mejor = (r.asesores || []).filter(a => a.cotizaciones >= 5 && a.convCot !== null).sort((a, b) => b.convCot - a.convCot)[0];
  if (mejor && mejor.convCot >= 15) out.push(`🏆 ${mejor.k} convierte el ${mejor.convCot} % de sus cotizaciones: es la referencia del equipo.`);
  if (k.pendientesEntrega) out.push(`🏍️ Hay ${k.pendientesEntrega} venta(s) facturada(s) sin entrega registrada.`);
  if (k.cotizacionesVencidas) out.push(`📝 ${k.cotizacionesVencidas} cotización(es) con seguimiento vencido: se enfrían cada hora.`);
  return out;
}
function embudoFases(r) {
  const orden = ['Nuevo', 'Contactado', 'Calificado', 'Interesado', 'Cotizado', 'Negociación', 'Pasa a facturar', 'Pendiente de entrega', 'Facturado', 'Moto entregada', 'Detenido', 'Perdido'], f = (r.kpis || {}).fases || {};
  return bars(orden.filter(x => f[x]).map(x => ({ l: x, v: f[x] })));
}
function ctlConversion(r) {
  const g = S.ctlGrupo || 'canal', nombres = { canal: 'Canal de origen', campana: 'Campaña', producto: 'Producto / modelo', tipo: 'Tipo de cliente', sede: 'Sede' };
  const rows = ((r.grupos || {})[g] || []).slice(0, 40), lect = lecturaIA(r);
  return `<div class="card" style="padding:12px;margin-bottom:12px"><h3 style="margin:0 0 6px">🤖 Lectura de la IA</h3>${lect.length ? lect.map(x => `<div class="small" style="margin:4px 0">${esc(x)}</div>`).join('') : '<div class="small muted">Aún no hay suficientes datos para sacar conclusiones.</div>'}</div>
    <h3 style="margin:0 0 8px">Embudo por fase</h3>${embudoFases(r) || '<p class="small muted">Sin datos.</p>'}
    <div class="seg" style="margin-bottom:10px">${Object.keys(nombres).map(x => `<button class="${g === x ? 'on' : ''}" data-tab="ctlGrupo" data-v="${x}">${nombres[x]}</button>`).join('')}</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>${nombres[g]}</th><th class="r">Leads</th><th class="r">Contactados</th><th class="r">Oportunidades</th><th class="r">Ventas</th><th class="r">Perdidos</th><th class="r">Conversión</th><th class="r">1ª resp.</th></tr></thead>
    <tbody>${rows.map(a => `<tr><td>${esc(a.k)}</td><td class="r">${a.leads}</td><td class="r">${a.contactados}</td><td class="r">${a.oportunidades}</td><td class="r">${a.ventas}</td><td class="r">${a.perdidos}</td><td class="r"><b>${a.conv} %</b></td><td class="r">${a.tResp === null || a.tResp === undefined ? '—' : fmtHoras(a.tResp)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Sin datos.</td></tr>'}</tbody></table></div>
    ${(r.kpis || {}).motivosPerdida && Object.keys(r.kpis.motivosPerdida).length ? `<h3 style="margin:14px 0 8px">Por qué se pierden las ventas</h3>${bars(Object.entries(r.kpis.motivosPerdida).map(([l, v]) => ({ l, v })).sort((a, b) => b.v - a.v))}` : ''}`;
}
function ctlRecuperacion(r) {
  const op = (r.oportunidades || []).filter(o => o.recuperar).sort((a, b) => (b.recuperar.prob === 'alta') - (a.recuperar.prob === 'alta') || b.score - a.score);
  const u = S.data.user, mias = u.rol === 'asesor' ? op.filter(o => norm(o.asesor) === norm(u.nombre)) : op;
  return `<h3 style="margin-bottom:8px">Motor de recuperación <span class="pill">${mias.length}</span></h3><p class="small muted" style="margin:0 0 8px">Oportunidades que no se cerraron: por qué, cuánta probabilidad tienen y qué hacer. Registra cada intento: queda en la trazabilidad y, si el cliente se recupera, vuelve a gestión.</p>
    ${mias.length ? mias.slice(0, 60).map(o => `<div class="card" style="margin-bottom:8px;padding:10px 12px"><div class="row between wrap" style="gap:8px"><div>
      <span class="pill ${o.recuperar.prob === 'alta' ? 'pill-ok' : o.recuperar.prob === 'media' ? 'pill-warn' : ''}">Prob. ${esc(o.recuperar.prob)}</span> <span class="pill">${esc(o.recuperar.cat)}</span>
      <b data-act="abrir" data-id="${esc(o.id_lead)}" style="cursor:pointer">${esc(o.nombre)}</b> <span class="muted small">· ${esc(o.producto)} · ${esc(o.asesor || 'Sin asesor')} · ★ ${o.score}</span>
      <div class="small" style="margin-top:4px"><b>Por qué:</b> ${esc(o.recuperar.porque)}</div><div class="small"><b>Qué hacer:</b> ${esc(o.recuperar.accion)}</div>
      ${o.recuperar.intentos ? `<div class="tiny muted">${o.recuperar.intentos} intento(s) de recuperación</div>` : ''}</div>
      <div class="row" style="gap:6px"><button class="btn btn-sm" data-act="abrir" data-id="${esc(o.id_lead)}">Abrir</button><button class="btn btn-sm btn-dark" data-act="rec-abrir" data-id="${esc(o.id_lead)}"><i class="ti ti-recycle"></i> Registrar intento</button></div></div></div>`).join('') : empty('ti-recycle', 'No hay oportunidades por recuperar ahora.')}`;
}
function ctlAlertas(r) {
  const nombres = { sla_primer_contacto: 'Primer contacto', escalamiento_admin: 'Escalamiento', reasignacion: 'Reasignación', lead_caliente_sin_atender: 'Lead caliente', negociacion_en_riesgo: 'En riesgo', lead_abandonado: 'Abandonado', alta_probabilidad_sin_gestion: 'Alta probabilidad', asesor_seguimientos_vencidos: 'Asesor con vencidos', proxima_accion_vencida: 'Próxima acción', contacto_sin_whatsapp: 'Contacto sin WhatsApp', moto_requerida: 'Moto requerida', nota_credito: 'Nota crédito', solicitud_reasignacion: 'Solicitud de reasignación' };
  return `<h3 style="margin-bottom:8px">Alertas recientes</h3>${(r.alertas || []).length ? (r.alertas || []).map(a => `<div class="card" style="margin-bottom:6px;padding:8px 12px"><div class="row between wrap"><span><span class="pill ${a.nivel === 'alta' ? 'pill-bad' : 'pill-warn'}">${esc(nombres[a.tipo] || a.tipo)}</span> <span class="small">${esc(String(a.mensaje).replace(/[\u{1F300}-\u{1FAFF}]|\n.*$/gu, '').trim())}</span></span><span class="tiny muted">${esc(a.fecha)}${a.destinatario ? ' · ' + esc(a.destinatario) : ''}</span></div></div>`).join('') : empty('ti-bell-off', 'Sin alertas recientes.')}`;
}
function ctlAuditoria(r) {
  return `<h3 style="margin-bottom:8px">Auditoría de actividades</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Usuario</th><th>Dónde</th><th>Qué cambió</th><th>Antes → Después</th><th>Origen</th></tr></thead><tbody>${(r.auditoria || []).map(a => `<tr><td class="small">${esc(a.fecha)}</td><td class="small">${esc(a.usuario)}</td><td class="small">${esc(a.hoja)} · ${esc(a.llave)}</td><td class="small">${esc(a.campo)}</td><td class="small">${esc(a.antes || '—')} → ${esc(a.despues || '—')}</td><td class="small">${esc(a.origen)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin registros.</td></tr>'}</tbody></table></div>`;
}
// Próxima acción: qué hará el asesor y cuándo (si no cumple: alerta → recordatorio → escalamiento)
function pedirProxima(l) {
  const dt = new Date(Date.now() + 2 * 3600e3), loc = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  return new Promise(res => {
    abrirSheet(`<div class="sheet-b"><h3>Próxima acción</h3><p class="small muted" style="margin:0">${esc(l.nombre)} · si no cumples, se te alerta, se te recuerda y se escala al administrador.</p>
      <label class="f" for="px-a">¿Qué vas a hacer?</label><select class="sel w100" id="px-a"><option value="">Elige…</option>${ACCIONES_PROX.map(a => `<option>${a}</option>`).join('')}</select>
      <label class="f" for="px-c">¿Cuándo?</label><input class="inp w100" type="datetime-local" id="px-c" value="${loc(dt)}" min="${loc(new Date())}">
      <label class="f" for="px-n">Nota (opcional)</label><input class="inp w100" id="px-n" maxlength="200" placeholder="Ej.: confirmar cuota inicial">
      <div class="row" style="justify-content:space-between"><button class="btn btn-sm" id="px-hecha">Marcar como hecha</button><span class="row"><button class="btn" id="c-no">Cancelar</button><button class="btn btn-primary" id="c-si" disabled>Guardar</button></span></div></div>`, true);
    const val = () => { $('#c-si').disabled = !($('#px-a').value && $('#px-c').value); };
    $('#px-a').onchange = val; $('#px-c').oninput = val;
    $('#c-no').onclick = () => { cerrarModal(); res(null); };
    $('#px-hecha').onclick = () => { cerrarModal(); res({ hecha: true }); };
    $('#c-si').onclick = () => { const r = { accion: $('#px-a').value, cuando: $('#px-c').value, nota: $('#px-n').value.trim() }; cerrarModal(); res(r); };
    S._modalCancel = () => res(null);
  });
}
async function programarProxima(l) {
  const r = await pedirProxima(l); if (!r) return;
  try { await api('proximaAccion', Object.assign({ id_lead: l.id }, r)); toast(r.hecha ? 'Acción marcada como hecha' : 'Próxima acción programada', 'ok'); S.ctlT = 0; if (S.view === 'control') { cargarControl(); } }
  catch (e) { toast(e.message, 'bad'); }
}
function pedirRecuperacion(o) {
  return new Promise(res => {
    abrirSheet(`<div class="sheet-b"><h3>Registrar intento de recuperación</h3><p class="small muted" style="margin:0">${esc(o.nombre)} · ${esc(o.recuperar.porque)}</p>
      <div class="notice small" style="padding:8px 10px"><i class="ti ti-bulb"></i><div><b>Sugerencia:</b> ${esc(o.recuperar.accion)}</div></div>
      <label class="f">¿Cómo salió?</label><div class="stack-sm">${[['sin_respuesta', 'Lo intenté y no respondió'], ['respondio', 'Respondió, sigue en conversación'], ['recuperado', 'Recuperado: vuelve a gestión'], ['descartado', 'Descartado: no hay posibilidad']].map(([v, t]) => `<label class="row small" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:#fff;cursor:pointer"><input type="radio" name="rc" value="${v}"> ${t}</label>`).join('')}</div>
      <label class="f" for="rc-n">¿Qué hiciste y qué dijo el cliente?</label><textarea class="inp w100" id="rc-n" rows="3" maxlength="250"></textarea>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="c-no">Cancelar</button><button class="btn btn-primary" id="c-si" disabled>Guardar intento</button></div></div>`, true);
    const val = () => { $('#c-si').disabled = !($('input[name=rc]:checked') && $('#rc-n').value.trim().length >= 5); };
    $$('input[name=rc]').forEach(i => { i.onchange = val; }); $('#rc-n').oninput = val;
    $('#c-no').onclick = () => { cerrarModal(); res(null); };
    $('#c-si').onclick = () => { const r = { resultado: $('input[name=rc]:checked').value, nota: $('#rc-n').value.trim() }; cerrarModal(); res(r); };
    S._modalCancel = () => res(null);
  });
}
async function registrarRecuperacion(id) {
  const o = ((S.ctl || {}).oportunidades || []).find(x => x.id_lead === id); if (!o || !o.recuperar) return;
  const r = await pedirRecuperacion(o); if (!r) return;
  try { await api('recuperar', Object.assign({ id_lead: id }, r)); toast('Intento registrado', 'ok'); S.ctlT = 0; cargarControl(); if (r.resultado === 'recuperado') await cargar(true); }
  catch (e) { toast(e.message, 'bad'); }
}

// ── Indicadores: embudo, asistencia a citas, cierre, NPS y calidad de datos ──
function vIndicadores() {
  if (!S.ind || Date.now() - (S.indT || 0) > 60000) cargarIndicadores();
  return `<div class="page-h"><div><h2>Indicadores</h2><p class="muted small">Embudo completo, asistencia a citas, motivos de pérdida, NPS y calidad de los datos. ${S.data.user.rol === 'asesor' ? 'Solo tus leads.' : ''}</p></div>
    <button class="btn btn-sm" data-act="ind-recargar"><i class="ti ti-refresh"></i> Actualizar</button></div>
    <div id="ind-cuerpo">${S.ind ? pintarIndicadores(S.ind) : '<div class="loading"><div><i class="ti ti-loader-2 spin"></i> Calculando indicadores…</div></div>'}</div>`;
}
function cargarIndicadores() {
  if (S.indBusy) return; S.indBusy = true;
  api('indicadores').then(r => { S.ind = r; S.indErr = ''; S.indT = Date.now(); })
    .catch(e => { S.indErr = e.message; })
    .finally(() => {
      S.indBusy = false;
      const c = $('#ind-cuerpo');
      if (S.view === 'indicadores' && c) c.innerHTML = S.ind ? pintarIndicadores(S.ind) : `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div>${esc(S.indErr)}</div></div>`;
    });
}
function pintarIndicadores(r) {
  const pct = (a, b) => b ? Math.round(a * 100 / b) + ' %' : '—';
  const c = r.citas || {}, n = r.nps || {}, cal = r.calidad || {};
  const hechas = (c.asistio || 0) + (c.no_asistio || 0);
  const emb = (r.embudo || []).map((e, i, arr) => ({ l: e.etapa, v: e.n, t: e.n + (i > 0 && arr[0].n ? ` · ${Math.round(e.n * 100 / arr[0].n)} %` : '') }));
  const motivos = {}; Object.entries(r.motivos_perdida || {}).forEach(([k, v]) => { motivos[k] = (motivos[k] || 0) + v; });
  const motEnc = Object.entries(r.motivos_encuesta || {}).map(([l, v]) => ({ l, v }));
  const asesores = (r.asesores || []).map(a => `<tr><td>${esc(a.asesor)}</td><td class="r">${a.leads}</td><td class="r">${pct(a.contactados, a.leads)}</td><td class="r">${a.t_resp_mediana_h === null || a.t_resp_mediana_h === undefined ? '—' : fmtHoras(a.t_resp_mediana_h)}</td>
    <td class="r">${a.citas}</td><td class="r">${pct(a.asistio, a.asistio + a.no_asistio)}</td><td class="r">${a.ganados}</td><td class="r">${a.perdidos}</td><td class="r">${a.reasignados || 0}</td>
    <td class="r">${a.nps_n ? Math.round((a.nps_prom - a.nps_det) * 100 / a.nps_n) : '—'}</td></tr>`).join('');
  const cuenta = o => Object.entries(o || {}).map(([l, v]) => ({ l, v })).sort((x, y) => y.v - x.v).slice(0, 8);
  const alertasCal = [['sin_zona', 'Leads sin zona (no se puede enrutar bien)'], ['sin_modelo', 'Leads sin modelo de interés'], ['sin_asesor', 'Leads sin asesor'], ['sin_etiqueta', 'Leads sin etiqueta de temperatura'], ['agendado_sin_cita', 'Marcados “agendado” sin cita registrada']].filter(([k]) => cal[k]);
  return `<div class="grid g-kpi">${kpi('Leads', (r.resumen || {}).leads || 0)}
      ${kpi('1ª respuesta (mediana)', (r.resumen || {}).mediana_primera_respuesta_h === null || (r.resumen || {}).mediana_primera_respuesta_h === undefined ? '—' : fmtHoras(r.resumen.mediana_primera_respuesta_h), 'Del primer mensaje al primer contacto')}
      ${kpi('Asistencia a citas', pct(c.asistio || 0, hechas), `${c.asistio || 0} asistieron · ${c.no_asistio || 0} no · ${c.pendientes || 0} pendientes`)}
      ${kpi('NPS', n.nps === null || n.nps === undefined ? '—' : n.nps, `${n.respondidas || 0} de ${n.enviadas || 0} respondieron`)}</div>
    <div class="grid g2">
      <div class="card"><h3 style="margin-bottom:8px">Embudo (leads que llegaron a cada etapa)</h3>${bars(emb)}</div>
      <div class="card"><h3 style="margin-bottom:8px">Motivos de pérdida</h3>${bars(Object.entries(motivos).map(([l, v]) => ({ l, v })).sort((a, b) => b.v - a.v), { vacio: 'Aún no hay leads perdidos con motivo.' })}
        ${motEnc.length ? `<h4 class="muted" style="margin:12px 0 6px">Según la encuesta al cliente</h4>${bars(motEnc)}` : ''}</div>
    </div>
    <div class="card"><h3 style="margin-bottom:8px">Desempeño por asesor</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Asesor</th><th class="r">Leads</th><th class="r">Contactados</th><th class="r">1ª resp.</th><th class="r">Citas</th><th class="r">Asistencia</th><th class="r">Ganados</th><th class="r">Perdidos</th><th class="r">Reasign.</th><th class="r">NPS</th></tr></thead><tbody>${asesores || '<tr><td colspan="10" class="muted">Sin datos.</td></tr>'}</tbody></table></div></div>
    ${Object.keys((r.detenidos || {}).motivos || {}).length ? `<div class="grid g2"><div class="card"><h3 style="margin-bottom:8px">Leads detenidos: por qué</h3>${bars(cuenta(r.detenidos.motivos))}</div>
      <div class="card"><h3 style="margin-bottom:8px"><i class="ti ti-package"></i> Motos requeridas sin inventario</h3>${bars(cuenta(r.detenidos.motos), { vacio: 'Ningún cliente espera una moto por falta de inventario.' })}<p class="tiny muted" style="margin:8px 0 0">Clientes detenidos esperando que llegue esa moto.</p></div></div>` : ''}
    <div class="grid g2">
      <div class="card"><h3 style="margin-bottom:8px">Lo que dicen los clientes (IA)</h3>
        <h4 class="muted" style="margin:0 0 6px">Uso de la moto</h4>${bars(cuenta((r.perfil || {}).uso_moto), { vacio: 'Sin datos todavía.' })}
        <h4 class="muted" style="margin:10px 0 6px">Objeción principal</h4>${bars(cuenta((r.perfil || {}).objecion), { vacio: 'Sin datos todavía.' })}
        <h4 class="muted" style="margin:10px 0 6px">Forma de pago</h4>${bars(cuenta((r.perfil || {}).forma_pago), { vacio: 'Sin datos todavía.' })}</div>
      <div class="card"><h3 style="margin-bottom:8px">Calidad de los datos</h3>
        ${alertasCal.length ? alertasCal.map(([k, t]) => `<div class="row" style="justify-content:space-between;padding:4px 0"><span class="small">${t}</span><span class="pill pill-warn">${cal[k]}</span></div>`).join('') : '<div class="notice ok"><i class="ti ti-circle-check"></i><div>Sin problemas de calidad detectados.</div></div>'}
        ${(n.comentarios || []).length ? `<h4 class="muted" style="margin:12px 0 6px">Comentarios NPS recientes</h4>${n.comentarios.map(x => `<p class="small" style="margin:0 0 6px"><b>${esc(x.nota)}</b> · ${esc(x.comentario)} <span class="muted">(${esc(x.asesor || '')})</span></p>`).join('')}` : ''}</div>
    </div>`;
}

// ── Bandeja de chats: todas las conversaciones (cliente, bot y asesores) dentro de la app ──
let bandejaTimer = null;
function cargarBandeja() {
  clearTimeout(bandejaTimer);
  api('bandeja').then(r => {
    S.bandeja = r.chats || []; S.bandejaErr = '';
    renderNav();
    if (S.view === 'chats') pintarBandeja();
  }).catch(e => { S.bandejaErr = e.message; if (S.view === 'chats') pintarBandeja(); })
    .finally(() => { if (!DEMO) bandejaTimer = setTimeout(cargarBandeja, 20000); });
}
function vChats() {
  if (!S.bandeja) { cargarBandeja(); }
  setTimeout(() => {
    pintarBandeja(); ajustarBandeja();
    const b = $('#chat-buscar'), f = $('#chat-filtro');
    if (b) b.oninput = () => { S.chatBuscar = b.value; pintarBandeja(); };
    if (f) f.onchange = () => { S.chatFiltro = f.value; pintarBandeja(); };
    if (S.chatSel) abrirChatBandeja(S.chatSel, true);
  }, 0);
  return `<div class="page-h"><div><h2>Chats</h2><p class="muted small">Conversaciones de WhatsApp con el número del negocio: cliente, bot y asesores. Responde desde aquí.</p></div>
      <div class="row"><input class="inp" id="chat-buscar" placeholder="Buscar cliente o asesor…" style="max-width:240px" value="${esc(S.chatBuscar || '')}">
      <select class="sel" id="chat-filtro">${opts([{ v: '', t: 'Todas' }, { v: 'espera', t: 'Esperan respuesta' }, { v: 'asesor', t: 'Con asesor (bot en pausa)' }, { v: 'bot', t: 'Atiende el bot' }], S.chatFiltro || '')}</select></div></div>
    <div class="inbox ${S.chatSel ? 'con-sel' : ''}"><div class="inbox-list" id="inbox-list"><div class="loading"><div><i class="ti ti-loader-2 spin"></i> Cargando chats…</div></div></div>
      <div class="inbox-chat" id="inbox-chat">${S.chatSel ? '' : '<div class="inbox-vacio"><i class="ti ti-messages"></i><p>Elige una conversación para verla y responder.</p></div>'}</div></div>`;
}
function pintarBandeja() {
  const el = $('#inbox-list'); if (!el) return;
  if (S.bandejaErr && !S.bandeja) { el.innerHTML = `<p class="small muted" style="padding:12px">No se pudo cargar: ${esc(S.bandejaErr)}</p>`; return; }
  if (!S.bandeja) return;
  const q = norm(S.chatBuscar || ''), f = S.chatFiltro || '';
  const lista = S.bandeja.filter(c => (!q || norm(c.nombre + ' ' + c.asesor + ' ' + c.ultimo).includes(q))
    && (!f || (f === 'espera' ? c.espera : c.estado === f)));
  el.innerHTML = lista.length ? lista.map(c => `<button class="inbox-item ${S.chatSel === c.id_lead ? 'on' : ''}" data-act="chat-abrir" data-id="${esc(c.id_lead)}">
      <div class="row" style="justify-content:space-between;gap:6px"><b class="ellipsis">${esc(c.nombre)}</b><span class="tiny muted">${c.fecha ? fmtFecha(new Date(c.fecha)) : ''}</span></div>
      <div class="small ellipsis ${c.espera ? 'inbox-espera' : 'muted'}">${c.remitente === 'cliente' ? '' : c.remitente === 'asesor' ? '<i class="ti ti-user"></i> ' : '<i class="ti ti-robot"></i> '}${esc(c.ultimo)}</div>
      <div class="row wrap" style="gap:4px;margin-top:4px">${c.estado === 'bot' ? '<span class="pill pill-ok">Bot</span>' : `<span class="pill pill-info">${esc(c.asesor || 'Asesor')}</span>`}${c.punto ? `<span class="pill">${esc(c.punto)}</span>` : ''}${c.espera && c.estado !== 'bot' ? '<span class="pill pill-warn">Espera respuesta</span>' : ''}${!c.ventana ? '<span class="pill pill-bad">+24 h</span>' : ''}</div>
    </button>`).join('') : '<p class="small muted" style="padding:12px">No hay conversaciones con este filtro.</p>';
}
function abrirChatBandeja(id, silencioso) {
  const l = S.M.byId[id];
  S.chatSel = id;
  document.querySelectorAll('.inbox-item').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  const box = $('#inbox-chat'); if (!box) return;
  $('.inbox') && $('.inbox').classList.add('con-sel');
  if (!l) { box.innerHTML = '<p class="small muted" style="padding:12px">Este lead no está en tu lista actual. Pulsa Actualizar.</p>'; return; }
  S.leadAbierto = id;
  box.innerHTML = `<div class="inbox-h"><button class="icon-btn inbox-back" data-act="chat-volver" title="Volver"><i class="ti ti-arrow-left"></i></button>
      <div class="grow"><b>${esc(l.nombre)}</b><div class="tiny muted">${esc(l.asesor || 'Sin asesor')} · ${esc(l.sede || 'Sin punto')}</div></div>
      <button class="btn btn-sm" data-act="abrir" data-id="${esc(id)}"><i class="ti ti-id"></i> Ficha</button></div>
    <div id="chat-estado" class="chat-estado"></div><div id="chat" class="chat inbox-msgs"></div><div id="chat-box"></div>`;
  cargarChat(id, true);
}

// ── Chat estilo WhatsApp: tipos de mensaje (imagen, audio, video, documento), separador de días y anuncio de origen ──
function etiquetaDia(d) {
  const f = x => x.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  if (f(d) === f(new Date())) return 'Hoy';
  if (f(d) === f(new Date(Date.now() - 864e5))) return 'Ayer';
  return d.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long' });
}
function horaChat(d) { return d ? d.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true }) : ''; }
function htmlAdjunto(m) {
  const t = m.tipo || 'text', u = m.media_url || '';
  if (['text', 'button', 'interactive'].includes(t)) return '';
  const e = { image: ['ti-photo', 'Imagen'], audio: ['ti-microphone', 'Nota de voz'], video: ['ti-video', 'Video'], document: ['ti-file-text', 'Documento'], location: ['ti-map-pin', 'Ubicación'], sticker: ['ti-mood-smile', 'Sticker'] }[t] || ['ti-paperclip', 'Archivo'];
  if (!u) return `<div class="msg-vacio"><i class="ti ${e[0]}"></i> ${e[1]} <span class="tiny">(no disponible)</span></div>`;
  if (t === 'image') return `<img class="msg-img" loading="lazy" src="${esc(u)}" alt="Imagen del chat" data-act="chat-zoom" data-url="${esc(u)}">`;
  if (t === 'audio') return `<div class="msg-media"><audio controls preload="none" src="${esc(u)}"></audio></div>`;
  if (t === 'video') return `<div class="msg-media"><video controls preload="metadata" src="${esc(u)}"></video></div>`;
  return `<a class="msg-doc" href="${esc(u)}" target="_blank" rel="noopener"><i class="ti ${e[0]}"></i> ${e[1]} · abrir</a>`;
}
function textoChat(txt) {
  let s = String(txt || ''), ins = '';
  const mp = /^\[Plantilla\s+([^\]]+)\]\s*/i.exec(s);
  if (mp) { ins = `<span class="msg-plantilla"><i class="ti ti-template"></i> Plantilla · ${esc(mp[1].replace(/_/g, ' '))}</span><br>`; s = s.slice(mp[0].length); }
  const h = esc(s).replace(/(https?:\/\/[^\s<]+)/g, u => /cotizador\.html/.test(u) ? `<a class="msg-link" href="${u}" target="_blank" rel="noopener">🏍️ Abrir cotizador</a>` : `<a class="msg-link" href="${u}" target="_blank" rel="noopener">${u.length > 38 ? u.slice(0, 38) + '…' : u}</a>`);
  return ins + h;
}
function htmlMensajes(ms) {
  let dia = '';
  return ms.map(m => {
    const rm = norm(m.remitente);
    const cls = rm.startsWith('asesor') ? 'ase' : /bot|ia|asistente|agente/.test(rm) ? 'bot' : 'cli';
    const quien = cls === 'ase' ? 'Asesor' : cls === 'bot' ? '🤖 Mateo' : '';
    const d = parseFecha(m.fecha_hora), etq = d ? etiquetaDia(d) : '';
    const sep = etq && etq !== dia ? (dia = etq, `<div class="chat-dia">${esc(etq)}</div>`) : '';
    return sep + `<div class="msg ${cls}">${quien ? `<span class="quien">${quien}</span>` : ''}${htmlAdjunto(m)}${textoChat(m.mensaje)}<small>${horaChat(d)}</small></div>`;
  }).join('');
}
function htmlAnuncio(a) {
  if (!a || !(a.headline || a.source_id)) return '';
  const img = a.image_url || a.thumbnail_url || '';
  return `<div class="anuncio-card"><div class="anuncio-top"><i class="ti ti-ad-2"></i> LLEGÓ DESDE UN ANUNCIO</div><div class="anuncio-body">${img ? `<img class="anuncio-img" src="${esc(img)}" alt="Anuncio" data-act="chat-zoom" data-url="${esc(img)}">` : ''}<div class="anuncio-txt"><b>${esc(a.headline || 'Anuncio de Facebook / Instagram')}</b>${a.body ? `<p>${esc(a.body)}</p>` : ''}<div class="tiny">ID del anuncio: ${esc(a.source_id || '—')}${a.media_type ? ' · ' + esc(a.media_type) : ''}</div>${a.source_url ? `<a href="${esc(a.source_url)}" target="_blank" rel="noopener">Ver anuncio ↗</a>` : ''}</div></div></div>`;
}
function zoomChat(url) {
  abrirSheet(`<div class="sheet-b"><img class="visor-img" src="${esc(url)}" alt=""><div class="row" style="justify-content:flex-end;margin-top:10px"><a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> Abrir</a><button class="btn btn-sm btn-dark" onclick="cerrarModal()">Cerrar</button></div></div>`, true);
}

// ── Chat del asesor (Fase 1): responde desde la app; el bot se pausa mientras hay asesor asignado ──
let chatTimer = null, chatSig = '';
function pintarChat(id, r2, forzarScroll) {
  if (S.leadAbierto !== id || !$('#chat')) return;
  const ms = r2.mensajes || [], at = r2.atencion || {};
  const sig = ms.length + '|' + (ms.length ? ms[ms.length - 1].fecha_hora : '') + '|' + at.estado + '|' + (r2.anuncio ? '1' : '0') + '|' + ms.filter(m => m.media_url).length;
  const c = $('#chat');
  const abajo = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
  if (sig !== chatSig) {
    chatSig = sig;
    c.innerHTML = ms.length ? htmlAnuncio(r2.anuncio) + htmlMensajes(ms) : '<p class="small muted">Sin mensajes para este contacto.</p>';
    if (forzarScroll || abajo) c.scrollTop = c.scrollHeight;
  }
  const pausado = at.estado !== 'bot' && at.asesor;
  const vence = at.vence_reasignacion ? new Date(at.vence_reasignacion) : null;
  $('#chat-estado').innerHTML = (pausado
    ? `<span class="pill pill-info"><i class="ti ti-player-pause"></i> Bot en pausa · atiende ${esc(at.asesor)}</span>${vence ? `<span class="pill ${vence - Date.now() < 90 * 60e3 ? 'pill-warn' : ''}" title="Lead nuevo: seguimiento a las 2 h y reasignación a las 4 h sin que el asesor lo toque. En proceso: seguimiento a las 13 h y reasignación a las 24 h en el mismo estado. Crédito en estudio: +12 h. Horas hábiles (7 a. m. – 9 p. m.). No aplica a retenidos.">Gestiona antes de: ${fmtFecha(vence)}</span>` : ''}`
    : `<span class="pill pill-ok"><i class="ti ti-robot"></i> Bot activo</span>`)
    + `<span class="pill ${at.ventana_abierta ? 'pill-ok' : 'pill-bad'}" title="WhatsApp permite texto libre solo 24 h después del último mensaje del cliente">${at.ventana_abierta ? 'Ventana WhatsApp abierta hasta ' + fmtFecha(new Date(at.ventana_cierra)) : 'Ventana de 24 h cerrada'}</span>`
    + (at.gestionado ? '<span class="pill pill-ok"><i class="ti ti-check"></i> Gestionado por el asesor</span>' : '')
    // El asesor no devuelve chats al bot: una vez asignado debe garantizar la gestión (solo Jefe/Admin pueden devolverlo).
    + (at.puede_escribir ? (pausado ? (S.data.user.rol !== 'asesor' && norm(at.asesor) !== norm(S.data.user.nombre) ? `<button class="btn btn-sm" data-act="chat-bot" data-id="${esc(id)}"><i class="ti ti-robot"></i> Devolver al bot</button>` : '')
      : `<button class="btn btn-sm btn-dark" data-act="chat-tomar" data-id="${esc(id)}"><i class="ti ti-hand-stop"></i> Tomar chat (pausar bot)</button>`) : '');
  const box = $('#chat-box');
  if (!box.dataset.listo) {
    box.dataset.listo = '1';
    box.innerHTML = at.puede_escribir ? `${chipsRespuestas(id, at)}<div class="emoji-panel" id="emoji-panel" hidden></div><div class="chat-box"><button type="button" class="icon-btn emoji-btn" data-act="emoji-abrir" title="Emojis" aria-label="Emojis">😊</button><textarea class="inp" id="chat-txt" rows="1" maxlength="3000" placeholder="Escribe tu respuesta al cliente…"></textarea>
      <button class="btn btn-primary" data-act="chat-enviar" data-id="${esc(id)}"><i class="ti ti-send"></i> Enviar</button></div><div class="chat-aviso" id="chat-aviso"></div>`
      : '<p class="chat-aviso">Solo el asesor asignado (o su jefe/administrador) puede escribirle a este cliente.</p>';
    const ta = $('#chat-txt'); if (ta) ta.addEventListener('input', () => autoAltoChat(ta));
  }
  ajustarBandeja();
  const aviso = $('#chat-aviso'), btn = box.querySelector('[data-act="chat-enviar"]');
  if (aviso) {
    const motivo = !at.envio_configurado ? 'El envío por WhatsApp no está configurado en el servidor.' : !at.ventana_abierta ? 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp exige una plantilla aprobada para retomarlo.' : '';
    aviso.textContent = motivo || 'El mensaje sale desde el número del negocio y queda registrado. Tu primer mensaje marca el lead como contactado.';
    if (btn) btn.disabled = !!motivo;
  }
}
// ── Ajuste automático del chat a la pantalla y emojis ──
function ajustarBandeja() {
  const ib = document.querySelector('.inbox'); if (!ib) return;
  const alto = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
  const nav = $('#nav'), navFijo = nav && getComputedStyle(nav).position === 'fixed' ? nav.offsetHeight : 0;
  ib.style.height = Math.max(340, alto - ib.getBoundingClientRect().top - navFijo - 14) + 'px';
}
function autoAltoChat(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; }
const EMOJIS = {
  '😊': '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😎 🤩 🤗 🤔 😬 🙄 😮 😢 😭 😡 😴',
  '👍': '👍 👎 👌 ✌️ 🤞 🤝 🙏 👏 🙌 💪 👋 ☝️ 👉 👈 👇 ✅ ❌ ⭐ 🌟 🔥 💯 ❤️ 💙 🎉 🎁',
  '🏍️': '🏍️ 🛵 🛞 ⛽ 🔧 🛠️ 🪖 🏁 🚦 🛣️ 🗺️ 📍 🏢 🏬 🕒 📅 📞 📱 💬 📲 🪪 📄 💳 💵 💰 🧾',
  '🚀': '🚀 🎯 🏆 🥇 ⚡ ✨ 🎊 🤩 😎 👀 🙋 🙋‍♂️ 🙋‍♀️ 🤙 💥 🆕 🔔 📣 ⏰ ➡️ ▶️ ☑️ 🔜 🆗 💡'
};
function pintarEmojis(cat) {
  const p = $('#emoji-panel'); if (!p) return;
  cat = cat || p.dataset.cat || '😊'; p.dataset.cat = cat;
  p.innerHTML = `<div class="emoji-tabs">${Object.keys(EMOJIS).map(k => `<button type="button" class="emoji-tab ${k === cat ? 'on' : ''}" data-act="emoji-cat" data-c="${k}">${k}</button>`).join('')}</div>
    <div class="emoji-grid">${EMOJIS[cat].split(' ').map(e => `<button type="button" class="emoji-e" data-act="emoji-add" data-e="${e}">${e}</button>`).join('')}</div>`;
}
function insertarEmoji(e) {
  const t = $('#chat-txt'); if (!t) return;
  const a = t.selectionStart == null ? t.value.length : t.selectionStart, b = t.selectionEnd == null ? a : t.selectionEnd;
  t.value = t.value.slice(0, a) + e + t.value.slice(b);
  t.focus(); t.selectionStart = t.selectionEnd = a + e.length; autoAltoChat(t);
}
window.addEventListener('resize', ajustarBandeja);
if (window.visualViewport) window.visualViewport.addEventListener('resize', ajustarBandeja);

// ── Copiloto del asesor: respuestas rápidas con los datos del lead (y sugerencia con IA si el Jefe activó la clave) ──
const RESPUESTAS_RAPIDAS = [
  { t: 'Saludo', k: 'saludo', m: '¡Hola {nombre}! Soy {asesor}, asesor de Moto Racing {punto}. Vi que te interesó la {modelo}. ¿Te cuento los detalles y simulamos tu cuota? 🏍️' },
  { t: 'Enviar simulador', k: 'cotizador', m: '{nombre}, aquí puedes simular tu cuota con el precio y el bono vigentes, sin compromiso: {cotizador}' },
  { t: 'Proponer visita', k: 'visita', m: '¿Te parece si te esperamos en {punto} para que conozcas la {modelo}? Dime qué día y a qué hora te queda mejor.' },
  { t: 'Confirmar cita', k: 'cita', m: '¡Perfecto {nombre}! Quedamos para tu visita en {punto}. Te esperamos 🙌' },
  { t: 'Dirección', k: 'dir', m: 'Estamos en {punto}{direccion}. ¡Te esperamos, {nombre}!' },
  { t: 'Objeción: precio', k: 'precio', m: 'Te entiendo, {nombre}. Podemos simular distintas cuotas iniciales y plazos para que la {modelo} se ajuste a tu presupuesto. ¿Qué cuota mensual te resultaría cómoda?' },
  { t: 'Objeción: crédito', k: 'credito', m: 'Tranquilo, {nombre}: hay opciones de financiación con varias entidades y la simulación es sin compromiso. Si quieres, lo revisamos juntos en el punto. ¿Cuándo puedes pasar?' },
  { t: 'Lo voy a pensar', k: 'pensar', m: 'Claro que sí, {nombre}, tómate tu tiempo. Si quieres te dejo la simulación de cuota para que la revises con calma y me escribes cuando quieras. ¿Te la envío?' },
  { t: 'Seguimiento', k: 'seg', m: 'Hola {nombre}, ¿pudiste revisar la {modelo}? Quedo atento para ayudarte con la cuota o agendar tu visita.' }
];
function chipsRespuestas(id, at) {
  const l = S.M.byId[id]; if (!l) return '';
  const per = ((S.data.fase2 || {}).perfiles || []).find(p => String(p.id_lead) === f2Key(l)) || {};
  const obj = norm(per.objecion_principal), paso = norm(per.siguiente_paso);
  const sug = new Set();
  if (/precio/.test(obj)) sug.add('precio'); if (/cuota|credito/.test(obj)) sug.add('credito'); if (/visita/.test(paso)) sug.add('visita'); if (/cotizador|credito/.test(paso)) sug.add('cotizador');
  if (!l.contactado) sug.add('saludo');
  return `<div class="qr" id="qr"><span class="tiny muted">Respuestas rápidas</span>${RESPUESTAS_RAPIDAS.map((r, i) => `<button type="button" class="qr-chip ${sug.has(r.k) ? 'sug' : ''}" data-act="qr-usar" data-i="${i}" data-id="${esc(id)}">${esc(r.t)}</button>`).join('')}
    ${at.ia_disponible ? `<button type="button" class="qr-chip qr-ia" data-act="qr-ia" data-id="${esc(id)}"><i class="ti ti-sparkles"></i> Sugerir con IA</button>` : ''}</div>`;
}
function textoRapido(i, id) {
  const l = S.M.byId[id], r = RESPUESTAS_RAPIDAS[i], u = S.data.user;
  const cap1 = s => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ''; };
  const modelo = l.raw.modelo_interes || l.raw.producto_cotizado || 'moto';
  const link = 'https://orregomejiaj-gif.github.io/crm-leads-motos/cotizador.html' + (l.tel ? '?c=57' + l.tel + '&m=' + encodeURIComponent(modelo) : '');
  const dir = String(l.raw.direccion_punto || '').trim();
  return r.m.replace(/\{nombre\}/g, cap1(String(l.nombre).split(' ')[0]) || 'amigo').replace(/\{asesor\}/g, cap1(String(u.nombre).split(' ')[0]))
    .replace(/\{punto\}/g, l.sede || 'nuestro punto').replace(/\{modelo\}/g, modelo).replace(/\{direccion\}/g, dir ? ' · ' + dir : '').replace(/\{cotizador\}/g, link);
}
async function usarRespuestaRapida(a) {
  const t = $('#chat-txt'); if (!t) return;
  if (a.dataset.act === 'qr-usar') { const txt = textoRapido(Number(a.dataset.i), a.dataset.id); t.value = t.value.trim() ? t.value.trim() + '\n' + txt : txt; t.focus(); return; }
  a.disabled = true; const antes = a.innerHTML; a.innerHTML = '<i class="ti ti-loader-2 spin"></i> Pensando…';
  try { const r = await api('sugerir', { id_lead: a.dataset.id, intencion: t.value.trim() }); t.value = r.texto; t.focus(); toast('Sugerencia lista: revísala y edítala antes de enviar.', 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
  finally { a.disabled = false; a.innerHTML = antes; }
}
function cargarChat(id, forzarScroll) {
  clearTimeout(chatTimer);
  if (forzarScroll) chatSig = '';
  const l = S.M.byId[id];
  if (!l || S.leadAbierto !== id || !$('#chat')) return;
  api('chats', { id_lead: l.id }).then(r2 => pintarChat(id, r2, forzarScroll))
    .catch(e => { if ($('#chat') && forzarScroll) $('#chat').innerHTML = `<p class="small muted">No se pudo cargar: ${esc(e.message)}</p>`; })
    .finally(() => { if (S.leadAbierto === id && !DEMO) chatTimer = setTimeout(() => cargarChat(id), document.hidden ? 30000 : 5000); });
}
async function enviarChat(id, btn) {
  const t = $('#chat-txt'), texto = (t.value || '').trim();
  if (!texto) return;
  btn.disabled = true;
  try {
    await api('enviarMensaje', { id_lead: S.M.byId[id].id, texto });
    t.value = ''; toast('Mensaje enviado', 'ok');
    cargarChat(id, true);
  } catch (e) { toast(e.message, 'bad'); }
  finally { btn.disabled = false; }
}
async function cambiarAtencionChat(id, estado) {
  try { await api('atencion', { id_lead: S.M.byId[id].id, estado }); toast(estado === 'bot' ? 'El bot vuelve a atender a este cliente' : 'Tomaste el chat: el bot queda en pausa', 'ok'); cargarChat(id, true); }
  catch (e) { toast(e.message, 'bad'); }
}

// ── Escrituras ────────────────────────────────────────────────────────────
async function setCampo(l, hoja, campo, valor) {
  const fila = hoja === 'Leads' ? l.raw : l.g;
  if (hoja === 'Gestion_Asesor' && !l.g) { toast('n8n aún no creó la fila de gestión de este lead.', 'bad'); return false; }
  const expected = fila ? String(fila[campo] ?? '') : undefined;
  try {
    const r = await api('update', { sheet: hoja, key: l.id, field: campo, value: valor, expected });
    if (r.conflict) { toast(r.error, 'bad'); await cargar(true); return false; }
    if (!r.sinCambio) {
      fila[campo] = valor;
      if (l.g && hoja === 'Gestion_Asesor') l.g.fecha_ultima_actualizacion = r.fecha || new Date().toISOString();
      (S.data.bitacora = S.data.bitacora || []).push({ fecha_hora: r.fecha || new Date().toISOString(), usuario: S.data.user.usuario, hoja, llave: l.id, campo, valor_anterior: expected, valor_nuevo: valor });
    }
    return true;
  } catch (e) { toast(e.message, 'bad'); return false; }
}
function refrescar() {
  construirModelo(); renderNav(); render();
  if (S.leadAbierto) abrirLead(S.leadAbierto);
}
function confirmar(titulo, cuerpo, ok = 'Continuar', peligro) {
  return new Promise(res => {
    abrirSheet(`<div class="sheet-b"><h3>${titulo}</h3><div class="small">${cuerpo}</div>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="c-no">Cancelar</button><button class="btn ${peligro ? 'btn-primary' : 'btn-dark'}" id="c-si">${ok}</button></div></div>`, true);
    $('#c-no').onclick = () => { cerrarModal(); res(false); };
    $('#c-si').onclick = () => { cerrarModal(); res(true); };
    S._modalCancel = () => res(false);
  });
}
// Registrar el contacto: por dónde, a qué hora, si contestó y qué dijo (obligatorio al marcar «Contactado» a mano o al justificar una alerta).
function pedirContacto(l, justificar) {
  const ahora = new Date(), loc = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  return new Promise(res => {
    abrirSheet(`<div class="sheet-b"><h3>${justificar ? 'Justificar el contacto' : 'Registrar el contacto'}</h3>
      <p class="small muted" style="margin:0">${esc(l.nombre)} · ${justificar ? 'figura como contactado sin mensaje tuyo por WhatsApp: cuenta por dónde y a qué hora lo contactaste.' : 'cuéntanos cómo lo contactaste.'}</p>
      <div class="notice small" style="padding:8px 10px"><i class="ti ti-brand-whatsapp"></i><div><b>Recuerda responderle por WhatsApp</b> desde el chat de la app: así queda el historial y el cliente recibe tu respuesta.</div></div>
      <label class="f" for="ct-canal">¿Por dónde lo contactaste?</label>
      <select class="sel w100" id="ct-canal"><option value="">Elige…</option><option>WhatsApp</option><option>Llamada</option><option>Presencial</option><option>Otro</option></select>
      <label class="f" for="ct-hora">¿Cuándo?</label><input class="inp w100" type="datetime-local" id="ct-hora" value="${loc(ahora)}" max="${loc(ahora)}">
      <label class="f">¿El cliente contestó?</label>
      <div class="row"><label class="small"><input type="radio" name="ct-resp" value="Sí"> Sí contestó</label><label class="small"><input type="radio" name="ct-resp" value="No"> No contestó</label></div>
      <label class="f" for="ct-nota">¿Qué dijo el cliente / qué pasó?</label><textarea class="inp w100" id="ct-nota" rows="3" maxlength="300" placeholder="Ej.: Quiere la TT200 a crédito, me pidió cotización por WhatsApp…"></textarea>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="c-no">Cancelar</button><button class="btn btn-primary" id="c-si" disabled>Guardar contacto</button></div></div>`, true);
    const val = () => { const ok = $('#ct-canal').value && $('#ct-hora').value && $('input[name=ct-resp]:checked') && $('#ct-nota').value.trim().length >= 5; $('#c-si').disabled = !ok; };
    ['#ct-canal', '#ct-hora', '#ct-nota'].forEach(s => { $(s).oninput = val; $(s).onchange = val; });
    $$('input[name=ct-resp]').forEach(i => { i.onchange = val; });
    $('#c-no').onclick = () => { cerrarModal(); res(null); };
    $('#c-si').onclick = () => { const r = { canal: $('#ct-canal').value, cuando: $('#ct-hora').value, contesto: $('input[name=ct-resp]:checked').value, nota: $('#ct-nota').value.trim() }; cerrarModal(); res(r); };
    S._modalCancel = () => res(null);
  });
}
async function registrarContacto(l, justificar) {
  const r = await pedirContacto(l, justificar); if (!r) return false;
  try { await api('contacto', Object.assign({ id_lead: l.id }, r)); toast('Contacto registrado. Recuerda responderle por WhatsApp desde el chat.', 'ok'); return true; }
  catch (e) { toast(e.message, 'bad'); return false; }
}
// Detenido: hay que justificar el porqué (decisión del cliente o falta de inventario → moto requerida).
const MOTIVOS_DETENIDO = [['reúne el dinero', 'El cliente está reuniendo el dinero'], ['busca deudor o codeudor', 'El cliente busca deudor o codeudor'], ['falta de inventario', 'La moto no está disponible (falta de inventario)'], ['otro motivo del cliente', 'Otro motivo del cliente']];
function pedirDetenido(l) {
  return new Promise(res => {
    abrirSheet(`<div class="sheet-b"><h3>Marcar como detenido</h3>
      <p class="small muted" style="margin:0">${esc(l.nombre)} · no recibirá seguimientos ni reasignaciones automáticas. Justifica por qué se detiene.</p>
      <div class="stack-sm">${MOTIVOS_DETENIDO.map(([v, t]) => `<label class="row small" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:#fff;cursor:pointer"><input type="radio" name="det-m" value="${esc(v)}"> ${esc(t)}</label>`).join('')}</div>
      <div id="det-moto" hidden><label class="f" for="det-moto-i">Moto requerida (modelo y color)</label><input class="inp w100" id="det-moto-i" maxlength="60" value="${esc(l.raw.modelo_interes || '')}" placeholder="Ej.: TT200 negro"><p class="tiny muted" style="margin:4px 0 0">Se le avisa al Jefe Comercial para gestionar el inventario.</p></div>
      <label class="f" for="det-nota">Detalle (opcional; obligatorio si es otro motivo)</label><textarea class="inp w100" id="det-nota" rows="2" maxlength="200"></textarea>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="c-no">Cancelar</button><button class="btn btn-primary" id="c-si" disabled>Marcar detenido</button></div></div>`, true);
    const val = () => {
      const m = ($('input[name=det-m]:checked') || {}).value; $('#det-moto').hidden = m !== 'falta de inventario';
      $('#c-si').disabled = !m || (m === 'falta de inventario' && $('#det-moto-i').value.trim().length < 3) || (m === 'otro motivo del cliente' && $('#det-nota').value.trim().length < 5);
    };
    $$('input[name=det-m]').forEach(i => { i.onchange = val; }); $('#det-moto-i').oninput = val; $('#det-nota').oninput = val;
    $('#c-no').onclick = () => { cerrarModal(); res(null); };
    $('#c-si').onclick = () => { const r = { motivo: $('input[name=det-m]:checked').value, moto: $('#det-moto-i').value.trim(), nota: $('#det-nota').value.trim() }; cerrarModal(); res(r); };
    S._modalCancel = () => res(null);
  });
}
async function registrarDetenido(l) {
  const r = await pedirDetenido(l); if (!r) return false;
  try { await api('detener', Object.assign({ id_lead: l.id }, r.motivo === 'falta de inventario' ? r : { motivo: r.motivo, nota: r.nota })); return true; }
  catch (e) { toast(e.message, 'bad'); return false; }
}
function pedirMotivo(l) {
  return new Promise(res => {
    abrirSheet(`<div class="sheet-b"><h3>Marcar como perdido</h3><p class="small muted" style="margin:0">${esc(l.nombre)} · el motivo es obligatorio.</p>
      <div class="stack-sm">${MOTIVOS.map(m => `<label class="row small" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:#fff;cursor:pointer"><input type="radio" name="motivo" value="${m}"> ${cap(m)}</label>`).join('')}</div>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="c-no">Cancelar</button><button class="btn btn-primary" id="c-si" disabled>Marcar perdido</button></div></div>`, true);
    $$('input[name=motivo]').forEach(i => { i.onchange = () => { $('#c-si').disabled = false; }; });
    $('#c-no').onclick = () => { cerrarModal(); res(null); };
    $('#c-si').onclick = () => { const v = ($('input[name=motivo]:checked') || {}).value; cerrarModal(); res(v || null); };
    S._modalCancel = () => res(null);
  });
}

// Cierre atómico en el servidor: resultado + motivo (obligatorio si se pierde) + fecha + etapa del embudo + encuesta programada.
async function cerrarLead(l, resultado, motivo) {
  try {
    await api('cierre', { id_lead: l.id, resultado, motivo: motivo || '' });
    const ahora = new Date().toISOString();
    if (l.g) { l.g.resultado = resultado; l.g.motivo_perdida = resultado === 'perdido' ? motivo : ''; l.g.fecha_ultima_actualizacion = ahora; }
    l.raw.resultado_venta = resultado; l.raw.fecha_cierre = ahora;
    etapaLocal(l, resultado === 'por facturar' ? 'Pasa a facturar' : resultado === 'perdido' ? 'Perdido' : 'Retenido');
    return true;
  } catch (e) { toast(e.message, 'bad'); return false; }
}
function f2Key(l) { return String(l.raw.id_lead || l.id); }
function etapaLocal(l, etapa) {
  const F = S.data.fase2 = S.data.fase2 || { citas: [], etapas: [], perfiles: [], encuestas: [] };
  F.etapas.push({ id_lead: f2Key(l), etapa, fecha: new Date().toISOString(), por: S.data.user.nombre });
}
async function recargarLead() { await cargar(true); if (S.leadAbierto) abrirLead(S.leadAbierto); }

// Devolver un lead a una etapa anterior: solo el Jefe Comercial autorizado (el servidor lo vuelve a validar).
const puedeReabrir = () => S.data.user.rol === 'jefe' && String(S.data.user.id) === '1038213114';
async function moverA(l, destino) {
  if (destino === l.estado) return;
  if (!puedeEditar(l)) { toast('Solo puedes mover tus propios leads.', 'bad'); return; }
  const orden = ESTADOS.indexOf.bind(ESTADOS);
  const retroceso = ['Nuevo', 'Contactado', 'Cotizado'].includes(destino) && (destino === 'Nuevo' || orden(destino) < orden(l.estado) || ['Facturado', 'Perdido', 'Retenido'].includes(l.estado));
  if (retroceso && puedeReabrir()) {
    if (l.cerrado) { toast('Este lead ya tiene la venta facturada en Síntesis: no se puede devolver (se corrige con nota crédito).', 'bad'); return; }
    if (!(await confirmar('Devolver el lead', `¿Devolver <b>${esc(l.nombre)}</b> de ${esc(lblEstado(l.estado, l.cerrado))} a <b>${esc(destino)}</b>? Se limpia el resultado y se reinicia su seguimiento.`, 'Devolver'))) return;
    try { await api('reabrir', { id_lead: l.id, estado: destino }); toast(`${l.nombre} → ${destino}`, 'ok'); } catch (e) { toast(e.message, 'bad'); }
    return refrescar();
  }
  if (destino === 'Nuevo' || (orden(destino) < orden(l.estado) && ['Contactado', 'Cotizado'].includes(destino)) || ['Facturado', 'Perdido'].includes(l.estado) && destino !== 'Retenido') {
    if (!(l.estado === 'Retenido' && ['Cotizado', 'Facturado', 'Perdido'].includes(destino))) {
      toast('Solo el Jefe Comercial autorizado puede devolver un lead a una etapa anterior.', 'bad'); return;
    }
  }
  if (!l.g) { toast('n8n aún no creó la fila de gestión de este lead.', 'bad'); return; }
  const leadTxt = `<b>${esc(l.nombre)}</b>`;
  if (destino === 'Contactado') {
    if (!(await registrarContacto(l, false))) return;
  } else if (destino === 'Cotizado') {
    if (!l.cot.length && !(await confirmar('Sin cotización en el CRM', `No hay una cotización cargada para ${leadTxt}. Si continúas, el lead queda marcado como <b>Inconsistencia</b> y el Jefe Comercial lo verá en Conciliación.`, 'Marcar igual'))) return;
    if (!l.contactado && !(await registrarContacto(l, false))) return refrescar();
    await setCampo(l, 'Gestion_Asesor', 'cotizado', 'Sí');
  } else if (destino === 'Facturado') {
    if (!l.fac.length && !(await confirmar('Pasa a facturar', `${leadTxt} queda en <b>Pasa a facturar</b>. Cuando la venta aparezca en el informe de ventas de Síntesis (mismo celular) pasa sola a <b>Cerrado ganado</b> y se habilita la revisión técnica.`, 'Pasa a facturar'))) return;
    if (!(await cerrarLead(l, 'por facturar'))) return refrescar();
  } else if (destino === 'Perdido') {
    const m = await pedirMotivo(l);
    if (!m) return;
    if (!(await cerrarLead(l, 'perdido', m))) return refrescar();
  } else if (destino === 'Retenido') {
    if (!(await registrarDetenido(l))) return;
  }
  toast(`${l.nombre} → ${lblEstado(destino)}`, 'ok');
  refrescar();
}

// ── Vista: Embudo (Kanban) ────────────────────────────────────────────────
function periodoDesde(p) {
  const now = new Date(), b = bparts(now);
  if (p === 'mes') return [bog(b.y, b.m, 1), null];
  if (p === 'mesant') return [bog(b.m === 1 ? b.y - 1 : b.y, b.m === 1 ? 12 : b.m - 1, 1), bog(b.y, b.m, 1)];
  if (p === 'todo') return [null, null];
  return [new Date(now - Number(p) * 864e5), null];
}
function filtrar(ls, f) {
  const [desde, hasta] = periodoDesde(f.periodo);
  return ls.filter(l => (!f.punto || l.sede === f.punto) && (!f.asesor || norm(l.asesor) === norm(f.asesor)) && (!f.origen || l.origen === f.origen) &&
    (!desde || (l.asign && l.asign >= desde)) && (!hasta || (l.asign && l.asign < hasta)));
}
function filtrosHTML(conOrigen = true) {
  const u = S.data.user, M = S.M, f = S.f;
  const sedes = uniq(M.leads.map(l => l.sede).concat(M.personas.map(p => p.sedeCanon))).filter(s => s === 'Itagüí' || s === 'Los Colores' || M.leads.some(l => l.sede === s));
  return `<div class="filters">
    ${u.rol === 'jefe' ? `<select class="sel" data-f="punto">${opts(sedes, f.punto, 'Todos los puntos')}</select>` : ''}
    ${u.rol !== 'asesor' ? `<select class="sel" data-f="asesor">${opts(uniq(M.asesores.filter(p => !f.punto || p.sedeCanon === f.punto).map(p => p.nombre).concat(M.leads.map(l => l.asesor))).sort(), f.asesor, 'Todos los asesores')}</select>` : ''}
    ${conOrigen ? `<select class="sel" data-f="origen">${opts(uniq(M.leads.map(l => l.origen)).sort(), f.origen, 'Todos los orígenes')}</select>` : ''}
    <select class="sel" data-f="periodo">${opts([{ v: '7', t: 'Últimos 7 días' }, { v: '30', t: 'Últimos 30 días' }, { v: '90', t: 'Últimos 90 días' }, { v: 'mes', t: 'Este mes' }, { v: 'mesant', t: 'Mes anterior' }, { v: 'todo', t: 'Todo' }], f.periodo)}</select>
  </div>`;
}
function vEmbudo() {
  const ls = filtrar(S.M.leads, S.f);
  return `<div class="page-h"><div><h2>Embudo</h2><p class="muted small">Arrastra una tarjeta para cambiar su estado (en celular usa “Mover a”). «Pasa a facturar» pasa solo a «Cerrado ganado» cuando la venta aparece en Síntesis.</p></div></div>
    ${filtrosHTML()}
    <div class="kanban">${ESTADOS.map(e => {
      const items = ls.filter(l => l.estado === e);
      return `<div class="col" data-col="${e}"><div class="col-h">${e === 'Facturado' ? 'Pasa a facturar / Cerrado ganado' : lblEstado(e)} <small>${items.length}</small></div>
        ${items.slice(0, 150).map(l => `<div class="kcard ${l.incons.length ? 'incons' : ''}" draggable="${puedeEditar(l)}" data-drag="${esc(l.id)}">
          <b data-act="abrir" data-id="${esc(l.id)}" style="cursor:pointer">${esc(l.nombre)}</b>
          <div class="muted">${esc(l.raw.modelo_interes || 'Sin modelo')} · ${esc(l.asesor || 'Sin asesor')}</div>
          <div class="row wrap" style="margin-top:4px;gap:4px">${pillTemp(l.temp || l.tempIA)}${l.incons.length ? '<span class="pill pill-bad">Inconsistencia</span>' : ''}${l.sla === 'bad' ? '<span class="pill pill-bad">SLA vencido</span>' : ''}</div>
          ${puedeEditar(l) && (puedeReabrir() || !['Facturado', 'Perdido'].includes(e)) ? `<select class="sel" data-mover="${esc(l.id)}"><option value="">Mover a…</option>${ESTADOS.filter(x => x !== e && (x !== 'Nuevo' || puedeReabrir())).map(x => `<option value="${x}">${lblEstado(x)}</option>`).join('')}</select>` : ''}
        </div>`).join('')}
        ${items.length > 150 ? `<div class="tiny muted">+${items.length - 150} más (usa filtros)</div>` : ''}
        ${!items.length ? '<div class="tiny muted" style="text-align:center;padding:12px">Vacío</div>' : ''}</div>`;
    }).join('')}${(() => {
      const otras = ls.filter(l => l.estado === 'Otra ciudad');
      return `<div class="col" data-col="Otra ciudad"><div class="col-h">Otra ciudad <small>${otras.length}</small></div>
        ${otras.slice(0, 150).map(l => `<div class="kcard"><b data-act="abrir" data-id="${esc(l.id)}" style="cursor:pointer">${esc(l.nombre)}</b><div class="muted">${esc(l.raw.zona || 'Sin ciudad')} · fuera de cobertura</div></div>`).join('')}
        ${!otras.length ? '<div class="tiny muted" style="text-align:center;padding:12px">Vacío</div>' : ''}</div>`;
    })()}</div>`;
}
function bindKanban() {
  $$('.kcard[draggable=true]').forEach(c => {
    c.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', c.dataset.drag); });
  });
  $$('.col').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', e => {
      e.preventDefault(); col.classList.remove('drop');
      const l = S.M.byId[e.dataTransfer.getData('text/plain')];
      if (l) moverA(l, col.dataset.col);
    });
  });
}

// ── Vista: Tablero de analista ────────────────────────────────────────────
function vAnalista() {
  const ls = filtrar(S.M.leads, S.f), M = S.M;
  const tot = ls.length;
  const contact = ls.filter(l => l.contactado || ['Cotizado', 'Facturado'].includes(l.estado));
  const conTiempo = ls.filter(l => l.hPrimera !== null);
  const aTiempo = conTiempo.filter(l => l.aTiempo).length;
  const tiempos = conTiempo.map(l => l.hPrimera).sort((a, b) => a - b);
  const mediana = tiempos.length ? tiempos[Math.floor(tiempos.length / 2)] : null;
  const cotiz = ls.filter(l => l.cotizado || ['Cotizado', 'Facturado'].includes(l.estado));
  const fact = ls.filter(l => l.estado === 'Facturado');
  const perd = ls.filter(l => l.estado === 'Perdido');

  // Leads por día
  const [desde] = periodoDesde(S.f.periodo);
  const dias = {}; ls.forEach(l => { if (l.asign) { const k = ymd(l.asign); dias[k] = (dias[k] || 0) + 1; } });
  const ks = Object.keys(dias).sort();
  const serie = [];
  if (ks.length) {
    let d = parseFecha(desde ? ymd(desde) : ks[0]); const fin = parseFecha(ymd(new Date()));
    for (let i = 0; d <= fin && i < 120; i++, d = new Date(d.getTime() + 864e5)) serie.push({ k: ymd(d), v: dias[ymd(d)] || 0 });
  }
  const maxD = Math.max(1, ...serie.map(s => s.v));

  // Embudo
  const etapas = [['Recibidos', tot], ['Contactados', contact.length], ['Cotizados', cotiz.length], ['Facturados', fact.length]];

  // Calidad del dato
  const campos = [['Teléfono', l => !!l.tel], ['Nombre', l => !!l.raw.nombre_completo], ['Modelo de interés', l => !!l.raw.modelo_interes], ['Zona', l => !!l.raw.zona], ['Forma de pago', l => !!l.raw.forma_pago], ['Origen', l => !!l.raw.origen], ['Asesor asignado', l => !!l.asesor]];

  // Inventario vs demanda
  const inv = S.data.inventario || [];
  const demanda = contar(ls.filter(l => l.raw.modelo_interes), l => String(l.raw.modelo_interes).trim());
  const invRow = m => inv.find(i => norm(i.modelo) === norm(m)) || inv.find(i => norm(m).includes(norm(i.modelo)) && norm(i.modelo).length > 3);
  const cel = v => v === '' || v === null || v === undefined ? '<span class="muted">sin dato</span>' : esc(v);

  // eNPS (respuesta 0–10 del cliente)
  const notas = ls.map(l => num(l.raw.cliente_respuesta_satisfaccion)).filter(v => v !== null && v >= 0 && v <= 10);
  const prom = notas.filter(v => v >= 9).length, det = notas.filter(v => v <= 6).length;
  const enps = notas.length ? Math.round((prom - det) / notas.length * 100) : null;

  return `<div class="page-h"><div><h2>Tablero</h2><p class="muted small">${tot} leads en el período · tiempos en horas hábiles</p></div></div>
    ${filtrosHTML()}
    <div class="grid g-kpi">
      ${kpi('Leads recibidos', tot)}
      ${kpi('Contacto ≤ ' + M.cfg.sla_preventiva_h + ' h hábil', fmtPct(pct(aTiempo, tot)), `${aTiempo} de ${tot} asignados`, pct(aTiempo, tot) === null ? '' : pct(aTiempo, tot) >= 80 ? 'ok' : pct(aTiempo, tot) >= 50 ? 'warn' : 'bad')}
      ${kpi('1ª respuesta (mediana)', fmtHoras(mediana), conTiempo.length + ' con fecha de contacto')}
      ${kpi('Conversión a factura', fmtPct(pct(fact.length, tot)), fact.length + ' facturados')}
      ${kpi('Perdidos', perd.length, fmtPct(pct(perd.length, tot)) + ' del total')}
      ${kpi('eNPS', enps === null ? '—' : enps, notas.length ? notas.length + ' respuestas' : 'sin respuestas 0–10')}
    </div>
    <div class="grid g2" style="margin-top:12px">
      <div class="card"><h3>Leads por día</h3>${serie.length ? `<div class="cols-chart">${serie.map(s => `<div class="c" style="height:${s.v / maxD * 100}%" title="${s.k}: ${s.v}"></div>`).join('')}</div><div class="row between tiny muted"><span>${serie[0].k}</span><span>${serie[serie.length - 1].k}</span></div>` : empty('ti-chart-bar-off', 'Sin leads en el período.')}</div>
      <div class="card"><h3 style="margin-bottom:10px">Embudo y conversión por etapa</h3><div class="funnel">${etapas.map((e, i) => `${i ? `<div class="conv">↓ ${fmtPct(pct(e[1], etapas[i - 1][1]))}</div>` : ''}<div class="st" style="width:${Math.max(45, 100 - i * 14)}%"><span>${e[0]}</span><b>${e[1]}</b></div>`).join('')}</div></div>
      <div class="card"><h3 style="margin-bottom:10px">Por origen</h3>${bars(contar(ls, l => l.origen))}</div>
      <div class="card"><h3 style="margin-bottom:10px">Por anuncio</h3>${bars(contar(ls.filter(l => l.anuncio), l => l.anuncio).slice(0, 10), { cls: 'alt', vacio: 'Ningún lead trae anuncio_origen.' })}</div>
      <div class="card"><h3 style="margin-bottom:10px">Por zona</h3>${bars(contar(ls, l => l.raw.zona).slice(0, 10), { cls: 'alt' })}</div>
      <div class="card"><h3 style="margin-bottom:10px">Perdidos por motivo</h3>${bars(contar(perd, l => l.motivo ? cap(l.motivo) : 'Sin motivo'), { vacio: 'Sin perdidos en el período.' })}</div>
      <div class="card"><h3 style="margin-bottom:10px">Cumplimiento de contacto por asesor</h3>${bars(contar(ls, l => l.asesor || 'Sin asesor').map(x => {
        const mis = ls.filter(l => (l.asesor || 'Sin asesor') === x.l); const ok = mis.filter(l => l.aTiempo).length;
        return { l: x.l, v: pct(ok, mis.length) || 0, t: `${ok}/${mis.length}`, cls: (pct(ok, mis.length) || 0) >= 80 ? 'ok' : 'warn' };
      }))}</div>
      <div class="card"><h3 style="margin-bottom:10px">Calidad del dato</h3>${tot ? bars(campos.map(([n, fn]) => { const c = ls.filter(fn).length; return { l: n, v: pct(c, tot), t: pct(c, tot) + '%', cls: pct(c, tot) >= 80 ? 'ok' : 'warn' }; })) : empty('ti-database-off', 'Sin leads.')}
        <p class="tiny muted" style="margin:8px 0 0">${ls.filter(l => !l.tel).length} lead(s) llegan solo con usuario de WhatsApp (sin teléfono).</p></div>
    </div>
    <div class="section-title"><i class="ti ti-building-warehouse"></i>Inventario vs demanda</div>
    ${demanda.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Modelo pedido</th><th class="r">Leads</th><th class="r">Disp. Itagüí</th><th class="r">Disp. Los Colores</th></tr></thead><tbody>
      ${demanda.map(d => { const i = invRow(d.l); return `<tr><td>${esc(d.l)}${i ? '' : ' <span class="pill">sin existencias en el último corte</span>'}</td><td class="r num">${d.v}</td><td class="r num">${i ? cel(i.disponible_itagui) : '—'}</td><td class="r num">${i ? cel(i.disponible_los_colores) : '—'}</td></tr>`; }).join('')}
    </tbody></table></div><p class="tiny muted">Existencias del repositorio de Inventario (último corte de Síntesis por punto). El detalle está en Inventario.</p>` : empty('ti-motorbike', 'Ningún lead del período tiene modelo de interés.')}`;
}

// ── Metas del mes: cómo vamos (vista "Metas" y ventana de bienvenida) ─────
function diasDelMes(mes) {
  const [y, m] = mes.split('-').map(Number), total = new Date(Date.UTC(y, m, 0)).getUTCDate(), hoy = bparts(new Date());
  const actual = `${hoy.y}-${pad(hoy.m)}`;
  const transc = mes === actual ? hoy.d : (mes < actual ? total : 0);
  return { total, transc, rest: total - transc };
}
function metaDe(mes, f) { return (S.data.metas || []).find(m => mesKey(m.mes) === mes && f(m)); }
// Resume el avance de un conjunto de leads contra su meta. Vendidas = lo mayor entre facturas cargadas y leads marcados ganados.
function armarAvance(nombre, ls, fac, metaRow, mes, extra) {
  // Lo vendido sale del Histórico de ventas (Síntesis, neto de notas crédito) cuando hay datos de ese mes; si no, de facturas o leads ganados.
  const d = diasDelMes(mes), gan = ls.filter(l => l.estado === 'Facturado').length, hist = extra && extra.hist !== undefined ? extra.hist : null;
  const motos = hist !== null ? hist : Math.max(fac, gan);
  const meta = metaRow ? num(metaRow.meta_motos) : null;
  const esperado = meta && d.total ? Math.round(meta * d.transc / d.total * 10) / 10 : null;
  const proy = d.transc ? Math.round(motos / d.transc * d.total) : null;
  const falta = meta !== null ? Math.max(meta - motos, 0) : null;
  return Object.assign({
    nombre, meta, motos, fac, gan, leads: ls.length, contactados: ls.filter(l => l.contactado || ['Cotizado', 'Facturado'].includes(l.estado)).length,
    cotizados: ls.filter(l => l.cotizado || ['Cotizado', 'Facturado'].includes(l.estado)).length, perdidos: ls.filter(l => l.estado === 'Perdido').length,
    pct: meta ? Math.round(motos * 100 / meta) : null, esperado, proy, falta,
    porDia: falta !== null && d.rest > 0 ? Math.round(falta / d.rest * 100) / 100 : null,
    ritmo: meta && esperado !== null ? (motos >= esperado ? 'ok' : motos >= esperado * 0.6 ? 'warn' : 'bad') : 'na', dias: d
  }, extra || {});
}
// «VALERIA HINCAPIE» (Metas) y «Valeria Incapie Cuartas» (Equipo) son la misma persona: se comparan los nombres con tolerancia de una letra.
function lev1(a, b) {
  if (a === b) return true; if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 5) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
}
function mismaPersona(a, b) {
  const ta = norm(a).split(/\s+/).filter(t => t.length > 1), tb = norm(b).split(/\s+/).filter(t => t.length > 1);
  if (!ta.length || !tb.length) return false;
  const comunes = ta.filter(x => tb.some(y => lev1(x, y))).length;
  return comunes >= Math.min(2, ta.length, tb.length);
}
function avancePunto(sede, mes) {
  const ls = S.M.leads.filter(l => l.sede === sede && l.asign && ym(l.asign) === mes);
  const fac = (S.data.facturas || []).filter(f => sedeCanon(f.sede) === sede && mesKey(f.fecha) === mes).length;
  let m = metaDe(mes, x => sedeCanon(x.persona) === sede) || metaDe(mes, x => sedeCanon(x.sede) === sede && norm(x.rol) === 'punto');
  if (!m) { // sin fila del punto: la meta del punto es la suma de las metas de su equipo (incluida la vacante)
    const eq = (S.data.metas || []).filter(x => mesKey(x.mes) === mes && sedeCanon(x.sede) === sede && norm(x.rol) !== 'punto');
    if (eq.length) m = { meta_motos: eq.reduce((s, x) => s + (num(x.meta_motos) || 0), 0) };
  }
  return armarAvance(sede, ls, fac, m, mes, { tipo: 'punto', hist: histVendidas(mes, x => x.punto === sede) });
}
// Motos vendidas según el Histórico de ventas; null si ese mes no se ha cargado todavía.
function histVendidas(mes, filtro) {
  const del = (S.data.ventasMes || []).filter(v => v.mes === mes);
  return del.length ? del.filter(filtro).reduce((s, v) => s + v.cantidad, 0) : null;
}
function avancePersona(p, mes) {
  const ls = S.M.leads.filter(l => norm(l.asesor) === norm(p.nombre) && l.asign && ym(l.asign) === mes);
  const fac = (S.data.facturas || []).filter(f => norm(f.asesor) === norm(p.nombre) && mesKey(f.fecha) === mes).length;
  const m = metaDe(mes, x => mismaPersona(x.persona, p.nombre));
  return armarAvance(p.nombre, ls, fac, m, mes, { tipo: 'asesor', sede: p.sedeCanon, hist: histVendidas(mes, x => norm(x.asesor) === norm(p.nombre)) });
}
function avanceGlobal(mes) {
  const u = S.data.user;
  if (u.rol === 'asesor') return { propio: avancePersona({ nombre: u.nombre, sedeCanon: u.sede }, mes), puntos: [] };
  const sedes = u.rol === 'jefe' ? ['Itagüí', 'Los Colores'] : [u.sede];
  const puntos = sedes.map(s => avancePunto(s, mes));
  const mismas = puntos.filter(p => p.meta !== null);
  const total = armarAvance(u.rol === 'jefe' ? 'Los dos puntos' : u.sede, [], 0, null, mes, { tipo: 'total' });
  total.leads = puntos.reduce((a, p) => a + p.leads, 0); total.contactados = puntos.reduce((a, p) => a + p.contactados, 0);
  total.cotizados = puntos.reduce((a, p) => a + p.cotizados, 0); total.perdidos = puntos.reduce((a, p) => a + p.perdidos, 0);
  total.motos = puntos.reduce((a, p) => a + p.motos, 0);
  total.meta = mismas.length ? mismas.reduce((a, p) => a + p.meta, 0) : null;
  const d = total.dias; total.pct = total.meta ? Math.round(total.motos * 100 / total.meta) : null;
  total.esperado = total.meta ? Math.round(total.meta * d.transc / d.total * 10) / 10 : null;
  total.proy = d.transc ? Math.round(total.motos / d.transc * d.total) : null;
  total.falta = total.meta !== null ? Math.max(total.meta - total.motos, 0) : null;
  total.porDia = total.falta !== null && d.rest > 0 ? Math.round(total.falta / d.rest * 100) / 100 : null;
  total.ritmo = total.meta ? (total.motos >= total.esperado ? 'ok' : total.motos >= total.esperado * 0.6 ? 'warn' : 'bad') : 'na';
  return { propio: null, puntos, total };
}
function barraMeta(a, grande) {
  if (a.meta === null) return `<div class="mt-sinmeta"><i class="ti ti-target-off"></i> Sin meta cargada para ${esc(fmtMes(a.mes || ''))} en la hoja Metas</div>`;
  const w = Math.min(a.pct || 0, 100), e = a.meta ? Math.min(a.esperado / a.meta * 100, 100) : 0;
  return `<div class="mt-barra ${grande ? 'grande' : ''}"><div class="mt-fill ${a.ritmo}" style="width:${w}%"></div>${a.esperado !== null ? `<div class="mt-marca" style="left:${e}%" title="Dónde deberías ir hoy"></div>` : ''}</div>
    <div class="mt-pie"><span><b>${a.motos}</b> de ${a.meta} motos · <b>${a.pct}%</b></span><span class="muted">${a.dias.rest > 0 ? `Faltan ${a.falta} en ${a.dias.rest} día${a.dias.rest === 1 ? '' : 's'}${a.porDia ? ` (${String(a.porDia).replace('.', ',')} por día)` : ''}` : (a.falta ? `Faltaron ${a.falta}` : '¡Meta cumplida!')}</span></div>`;
}
function textoRitmo(a) {
  if (a.meta === null || a.esperado === null || !a.dias.transc) return '';
  if (a.motos >= a.meta) return '🎉 ¡Meta cumplida!';
  if (a.ritmo === 'ok') return `Vamos al día: a hoy deberíamos llevar ${String(a.esperado).replace('.', ',')} y llevamos ${a.motos}.`;
  return `A hoy deberíamos llevar ${String(a.esperado).replace('.', ',')} motos y llevamos ${a.motos}. ${a.proy !== null ? `Al ritmo actual cerraríamos en ${a.proy}.` : ''}`;
}

function vMetas() {
  const u = S.data.user;
  S.mes = S.mes || mesesRecientes(1)[0];
  const mes = S.mes, G = avanceGlobal(mes), hojaMetas = S.data.hojas.Metas;
  const card = a => { a.mes = mes; return `<div class="card mt-card"><div class="card-h"><h3>${esc(a.nombre)}</h3>${a.meta !== null ? `<span class="pill pill-${a.ritmo === 'na' ? '' : a.ritmo}">${a.ritmo === 'ok' ? 'Al día' : a.ritmo === 'warn' ? 'Atento' : a.ritmo === 'bad' ? 'Por debajo del ritmo' : ''}</span>` : ''}</div>
    ${barraMeta(a)}<p class="small muted" style="margin:6px 0 10px">${esc(textoRitmo(a))}</p>
    <div class="mt-mini"><div><b>${a.leads}</b><span>Leads</span></div><div><b>${a.contactados}</b><span>Contactados</span></div><div><b>${a.cotizados}</b><span>Cotizados</span></div><div><b>${a.motos}</b><span>Vendidas</span></div><div><b>${a.perdidos}</b><span>Perdidos</span></div></div>
    ${a.hist !== null && a.hist !== undefined ? `<p class="tiny muted" style="margin:8px 0 0">Vendidas según el Histórico de ventas de Síntesis (neto de notas crédito).</p>` : a.fac !== a.gan ? `<p class="tiny muted" style="margin:8px 0 0">Facturas cargadas: ${a.fac} · leads marcados ganados: ${a.gan}. Se cuenta el mayor hasta cargar el Histórico de ventas.</p>` : ''}</div>`; };
  let cuerpo;
  if (u.rol === 'asesor') cuerpo = `<div class="grid g2">${card(G.propio)}</div>`;
  else {
    const personas = S.M.asesores.filter(p => u.rol === 'jefe' || p.sedeCanon === u.sede).map(p => avancePersona(p, mes)).sort((x, y) => (y.pct ?? -1) - (x.pct ?? -1));
    G.total.mes = mes;
    cuerpo = `${G.puntos.length > 1 ? `<div class="grid g2">${card(G.total)}</div>` : ''}
      <div class="grid g2">${G.puntos.map(card).join('')}</div>
      <div class="section-title"><i class="ti ti-users"></i>Por asesor</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Asesor</th><th>Punto</th><th class="r">Leads</th><th class="r">Vendidas</th><th class="r">Meta</th><th style="min-width:150px">Avance</th></tr></thead><tbody>
      ${personas.map(a => `<tr><td><b>${esc(a.nombre)}</b></td><td>${esc(a.sede || '')}</td><td class="r num">${a.leads}</td><td class="r num">${a.motos}</td><td class="r num">${a.meta === null ? '<span class="muted">—</span>' : a.meta}</td>
        <td>${a.meta === null ? '<span class="muted small">Sin meta</span>' : `<div class="mt-barra"><div class="mt-fill ${a.ritmo}" style="width:${Math.min(a.pct, 100)}%"></div></div><span class="tiny muted">${a.pct}%</span>`}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin asesores.</td></tr>'}</tbody></table></div>`;
  }
  return `<div class="page-h"><div><h2>Metas</h2><p class="muted small">Cómo vamos con la meta del mes. La meta sale de la hoja Metas; lo vendido, de las facturas y de los leads marcados como ganados.</p></div>
      <div class="row"><select class="sel" data-ch="mes">${opts(mesesRecientes(12).map(m => ({ v: m, t: fmtMes(m) })), mes)}</select><button class="btn btn-sm btn-dark" data-act="ver-bienvenida"><i class="ti ti-presentation"></i> Ver resumen grande</button></div></div>
    ${!hojaMetas ? '<div class="notice"><i class="ti ti-target-off"></i><div>La hoja <b>Metas</b> aún no existe.</div></div>' : ''}${cuerpo}`;
}

// Ventana grande al entrar: cómo vamos con los leads y con la meta del mes
function mostrarBienvenida() {
  const u = S.data.user, L = leadsAlcance();
  const hora = bparts(new Date()).h, saludo = hora < 12 ? 'Buenos días' : hora < 18 ? 'Buenas tardes' : 'Buenas noches';
  const abiertos = L.filter(l => !['Facturado', 'Perdido', 'Retenido', 'Otra ciudad'].includes(l.estado));
  const nuevos = abiertos.filter(l => l.estado === 'Nuevo').length, cotizados = L.filter(l => l.cotizado).length, vendidos = L.filter(l => l.estado === 'Facturado').length;
  const msg = nuevos ? `Tienes ${nuevos} lead${nuevos === 1 ? '' : 's'} sin contactar: el primero que responde, vende. Empieza por ahí.` : (abiertos.length ? 'No hay leads sin contactar. Sigue las cotizaciones y las próximas acciones del día.' : 'Aún no hay leads abiertos. Cuando entren por la pauta o por referidos aparecerán aquí.');
  const kp = (n, t, c) => `<div class="wl-kpi ${c || ''}"><b data-n="${n}">0</b><span>${t}</span></div>`;
  const html = `<div class="wl-backdrop" data-wl-cerrar></div><div class="wl-card" role="dialog" aria-modal="true" aria-label="Resumen de leads">
    <button class="icon-btn wl-x" data-wl-cerrar title="Cerrar"><i class="ti ti-x"></i></button>
    <div class="wl-top"><div class="wl-saludo">${saludo}, ${esc(String(u.nombre).split(' ')[0])} 👋</div><div class="wl-mes">Gestión de leads · pauta en redes y referidos</div></div>
    <div class="wl-kpis">${kp(abiertos.length, 'Leads abiertos')}${kp(nuevos, 'Sin contactar', nuevos ? 'wl-venta' : '')}${kp(cotizados, 'Cotizados')}${kp(vendidos, 'Vendidos', 'wl-venta')}</div>
    <div class="wl-meta"><div class="wl-meta-t"><i class="ti ti-bolt"></i> Lo primero hoy</div><p class="wl-ritmo">${esc(msg)}</p></div>
    <div class="wl-acciones"><button class="btn btn-primary wl-entrar" data-wl-cerrar><i class="ti ti-arrow-right"></i> Entrar a la app</button></div></div>`;
  let w = $('#welcome');
  if (!w) { w = document.createElement('div'); w.id = 'welcome'; w.className = 'welcome'; document.body.appendChild(w); }
  w.innerHTML = html; w.hidden = false; document.body.style.overflow = 'hidden';
  // Los números suben de 0 al valor real
  $$('.wl-kpi b', w).forEach(el => {
    const fin = Number(el.dataset.n) || 0, t0 = performance.now();
    const paso = t => { const k = Math.min((t - t0) / 700, 1); el.textContent = Math.round(fin * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(paso); };
    requestAnimationFrame(paso);
  });
  setTimeout(() => { const b = $('.wl-entrar', w); if (b) b.focus(); }, 50);
}
function cerrarBienvenida(ir) {
  const w = $('#welcome'); if (w) w.hidden = true;
  document.body.style.overflow = $('#sheet').hidden ? '' : 'hidden';
  if (ir) { S.view = ir; renderNav(); render(); window.scrollTo(0, 0); }
}

// ── Vista: Comisiones ─────────────────────────────────────────────────────
function mesesRecientes(n) {
  const b = bparts(new Date()); const out = [];
  for (let i = 0; i < n; i++) { let m = b.m - i, y = b.y; while (m < 1) { m += 12; y--; } out.push(`${y}-${pad(m)}`); }
  return out;
}
function metricasPersona(nombre, mes) {
  const M = S.M;
  const mis = M.leads.filter(l => norm(l.asesor) === norm(nombre) && l.asign && ym(l.asign) === mes);
  const facts = (S.data.facturas || []).filter(f => norm(f.asesor) === norm(nombre) && mesKey(f.fecha) === mes);
  const meta = (S.data.metas || []).find(m => mismaPersona(m.persona, nombre) && mesKey(m.mes) === mes);
  return {
    asignados: mis.length,
    aTiempo: mis.filter(l => l.aTiempo).length,
    contactados: mis.filter(l => l.contactado || ['Cotizado', 'Facturado'].includes(l.estado)).length,
    cotizados: mis.filter(l => l.cotizado || ['Cotizado', 'Facturado'].includes(l.estado)).length,
    facturados: facts.length,
    marcadosGanados: mis.filter(l => l.estado === 'Facturado').length,
    valor: facts.reduce((s, f) => s + (num(f.valor) || 0), 0),
    meta: meta ? num(meta.meta_motos) : null,
    perdidos: mis.filter(l => l.estado === 'Perdido').length,
    mis, facts
  };
}
/** Detalle de la comisión por venta: valor vendido (Síntesis cruzado con la factura), descuento frente al precio final del catálogo y cuánto se gana o se deja de ganar. */
function detalleComision(filas) {
  const tasaBase = COMISION.escala[COMISION.escala.length - 1].tasa, fmtT = t => (t * 100).toFixed(1).replace('.', ',') + ' %';
  const cards = filas.filter(f => f.facts && f.facts.length).map(f => {
    const c = comisionDe(f), tasa = c.tasa || tasaBase, ventas = f.facts.map(x => {
      const v = num(x.valor) || 0, fin = num(x.precio_final) || 0, desc = fin ? (fin - v) * 100 / fin : null;
      return { x, v, fin, desc, com: Math.round((COMISION.valorIncluyeIva ? v / (1 + COMISION.iva) : v) * c.tasa), perdida: fin && v < fin ? Math.round((fin - v) * tasa) : 0 };
    });
    const conPrecio = ventas.filter(s => s.desc !== null), prom = conPrecio.length ? conPrecio.reduce((a, s) => a + s.desc, 0) / conPrecio.length : null;
    const dejado = ventas.reduce((a, s) => a + s.perdida, 0), sube = c.siguiente ? Math.round(f.valor * c.siguiente.tasa) - c.valor : 0;
    const chip = s => s.desc === null ? '<span class="tiny muted">sin precio de catálogo</span>' : s.desc <= 0 ? `<span class="pill pill-ok">✅ ${s.desc < -0.05 ? 'por encima del precio final' : 'sin descuento'}</span>` : s.desc <= 2 ? `<span class="pill pill-ok">🟢 ${s.desc.toFixed(1).replace('.', ',')} % desc.</span>` : `<span class="pill pill-warn">🟠 ${s.desc.toFixed(1).replace('.', ',')} % desc.</span>`;
    return `<div class="card" style="margin-bottom:10px;padding:12px"><div class="row between wrap" style="gap:8px"><b>${esc(f.p.nombre)}</b><span class="small">${c.cumpl === null ? 'sin meta' : `📊 ${c.cumpl.toFixed(0)} % de la meta`} · tasa <b>${c.tasa ? fmtT(c.tasa) : '—'}</b> · comisión <b>${money(c.valor)}</b></span></div>
      <div class="small" style="margin:6px 0">${prom === null ? '' : `🏷️ Descuento promedio sobre el precio final: <b>${prom.toFixed(1).replace('.', ',')} %</b>. `}${dejado ? `💸 Por descuentos dejaste de ganar ~<b>${money(dejado)}</b>${c.tasa ? '' : ' (con la tasa del 90 %)'}. ` : '✅ Sin descuentos que resten comisión. '}${c.siguiente && c.cumpl !== null ? `🚀 Con ${c.siguiente.motos} moto${c.siguiente.motos > 1 ? 's' : ''} más llegas al ${fmtT(c.siguiente.tasa)} y tu comisión sube ~<b>${money(Math.max(0, sube))}</b> (la tasa aplica a todas tus motos).` : c.tasa ? '🏆 Estás en la escala máxima.' : ''}</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Factura</th><th>Modelo</th><th class="r">Valor vendido</th><th class="r">Precio final</th><th>Descuento</th><th class="r">Comisión</th></tr></thead><tbody>${ventas.map(s => `<tr><td>${esc(s.x.id_factura)}</td><td>${esc(s.x.modelo || '')}</td><td class="r num">${money(s.v)}</td><td class="r num">${s.fin ? money(s.fin) : '—'}</td><td>${chip(s)}</td><td class="r num">${money(s.com)}</td></tr>`).join('')}</tbody></table></div></div>`;
  }).join('');
  return cards ? `<div class="section-title"><i class="ti ti-receipt-2"></i>Comisión por venta y descuentos</div><p class="small muted" style="margin:0 0 8px">El valor a comisionar es el valor de la venta en Síntesis, cruzado con su factura (neto de notas crédito). Mientras más alto se venda y menos descuento se dé, mayor la comisión. El precio final es el de la hoja «precios de venta con bonos».</p>${cards}` : '';
}
// Escala de comisión (regla del Jefe Comercial): según el % de cumplimiento de la meta de motos, se paga ese porcentaje sobre cada moto facturada, antes de IVA.
const COMISION = { escala: [{ min: 120, tasa: 0.014 }, { min: 110, tasa: 0.012 }, { min: 100, tasa: 0.01 }, { min: 90, tasa: 0.006 }], valorIncluyeIva: true, iva: 0.19 }; // El valor de Síntesis coincide con el precio final al público del catálogo (que incluye IVA); la comisión se liquida antes de IVA.
function comisionDe(f) {
  const cumpl = f.meta ? f.facturados * 100 / f.meta : null;
  const esc = cumpl === null ? null : COMISION.escala.find(e => cumpl >= e.min), base = COMISION.valorIncluyeIva ? f.valor / (1 + COMISION.iva) : f.valor;
  const sig = cumpl === null ? null : COMISION.escala.slice().reverse().find(e => cumpl < e.min);
  return { cumpl, tasa: esc ? esc.tasa : 0, valor: esc ? Math.round(base * esc.tasa) : 0, base,
    siguiente: sig ? { tasa: sig.tasa, motos: Math.max(1, Math.ceil(f.meta * sig.min / 100 - 1e-9) - f.facturados), min: sig.min } : null };
}
function vComisiones() {
  const u = S.data.user, M = S.M;
  S.mes = S.mes || mesesRecientes(1)[0];
  let personas = u.rol === 'asesor' ? [{ nombre: u.nombre, sedeCanon: u.sede, rolApp: 'asesor' }] :
    M.asesores.filter(p => u.rol === 'jefe' || p.sedeCanon === u.sede);
  const filas = personas.map(p => Object.assign({ p }, metricasPersona(p.nombre, S.mes)));
  const sinFact = !S.data.hojas.Facturas, sinMetas = !S.data.hojas.Metas;
  return `<div class="page-h"><div><h2>Comisiones</h2><p class="muted small">Por asesor y mes. Las motos facturadas salen de la hoja Facturas.</p></div>
      <select class="sel" data-ch="mes">${opts(mesesRecientes(12).map(m => ({ v: m, t: fmtMes(m) })), S.mes)}</select></div>
    <div class="notice" style="margin-bottom:10px"><i class="ti ti-coin"></i><div><b>Escala de comisión por cumplimiento de la meta</b> (sobre cada moto facturada, antes de IVA):<br>
      <span class="small">🔹 90 % → 0,6 % · 🔹 100 % → 1 % · 🔹 110 % → 1,2 % · 🔹 120 % → 1,4 %. Por debajo de 90 % no hay comisión. Base: valor facturado en Síntesis, neto de notas crédito${COMISION.valorIncluyeIva ? ` (se le descuenta el IVA ${COMISION.iva * 100} %)` : ' (se toma como valor antes de IVA)'}. Estimada: la liquidación oficial la define el Jefe.</span></div></div>
    ${sinFact ? '<div class="notice bad" style="margin-bottom:10px"><i class="ti ti-file-off"></i><div>Falta la hoja <b>Facturas</b>: facturados y valor se muestran en 0 hasta que exista (solicitud al Sheet).</div></div>' : ''}
    ${sinMetas ? '<div class="notice" style="margin-bottom:10px"><i class="ti ti-target-off"></i><div>Falta la hoja <b>Metas</b>: la meta se muestra en blanco.</div></div>' : ''}
    ${filas.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Asesor</th><th>Punto</th><th class="r">Asignados</th><th class="r">Contactados a tiempo</th><th class="r">Cotizados</th><th class="r">Facturados</th><th class="r">Meta</th><th class="r">% meta</th><th class="r">Valor facturado</th><th class="r">Comisión</th></tr></thead><tbody>
      ${filas.map(f => `<tr><td><b>${esc(f.p.nombre)}</b>${f.p.rolApp === 'admin' ? ' <span class="pill">Admin</span>' : ''}</td><td>${esc(f.p.sedeCanon || '')}</td>
        <td class="r num">${f.asignados}</td><td class="r num">${f.aTiempo} <span class="muted tiny">${fmtPct(pct(f.aTiempo, f.asignados))}</span></td><td class="r num">${f.cotizados}</td>
        <td class="r num">${f.facturados}${f.marcadosGanados > f.facturados ? ` <span class="pill pill-warn" title="Marcados ganados sin factura">+${f.marcadosGanados - f.facturados} sin factura</span>` : ''}</td>
        <td class="r num">${f.meta === null ? '<span class="muted">—</span>' : f.meta}</td><td class="r num">${f.meta ? fmtPct(pct(f.facturados, f.meta)) : '—'}</td>
        <td class="r num">${money(f.valor)}</td><td class="r num">${(() => { const c = comisionDe(f); return f.meta ? `<b>${money(c.valor)}</b> <span class="tiny muted">(${(c.tasa * 100).toFixed(1).replace('.', ',')} %)</span>${c.siguiente ? `<div class="tiny muted">🎯 ${c.siguiente.motos} moto${c.siguiente.motos > 1 ? 's' : ''} más para el ${(c.siguiente.tasa * 100).toFixed(1).replace('.', ',')} %</div>` : '<div class="tiny muted">🏆 escala máxima</div>'}` : '<span class="muted">Sin meta</span>'; })()}</td></tr>`).join('')}
    </tbody></table></div>` : empty('ti-users', 'No hay asesores en la hoja Equipo para este alcance.')}
    ${detalleComision(filas)}
    ${u.rol !== 'asesor' ? `<div class="section-title"><i class="ti ti-building-store"></i>Por punto</div><div class="grid g2">${['Itagüí', 'Los Colores'].filter(s => u.rol === 'jefe' || s === u.sede).map(s => {
      const fs = (S.data.facturas || []).filter(f => sedeCanon(f.sede) === s && mesKey(f.fecha) === S.mes);
      const meta = (S.data.metas || []).find(m => sedeCanon(m.persona) === s && mesKey(m.mes) === S.mes) || (S.data.metas || []).find(m => sedeCanon(m.sede) === s && norm(m.rol) === 'punto' && mesKey(m.mes) === S.mes);
      const mv = meta ? num(meta.meta_motos) : null;
      return `<div class="kpi"><div class="k-l">${s}</div><div class="k-v">${fs.length}${mv ? ' / ' + mv : ''} motos</div><div class="k-s">${mv ? fmtPct(pct(fs.length, mv)) + ' de la meta' : 'Meta del punto sin cargar en Metas'} · ${money(fs.reduce((a, f) => a + (num(f.valor) || 0), 0))}</div></div>`;
    }).join('')}</div>` : ''}`;
}

// ── Vista: Seguimientos comerciales ───────────────────────────────────────
const EVAL_ASESOR = [
  ['atencion', 'Atención por WhatsApp (velocidad y calidad)'], ['producto', 'Conocimiento del portafolio de motos'],
  ['financiacion', 'Manejo de financiación y medios de pago'], ['objeciones', 'Manejo de objeciones'],
  ['cierre', 'Técnica de cierre y seguimiento a cotizaciones'], ['registro', 'Registro de la gestión en el CRM al día'],
  ['presentacion', 'Presentación personal y actitud']
];
const EVAL_PUNTO = [
  ['exhibicion', 'Exhibición de motos y orden del punto'], ['precios', 'Precios y material POP visibles'],
  ['inventario', 'Inventario disponible vs demanda'], ['equipo', 'Trabajo en equipo y cubrimiento de horarios'],
  ['experiencia', 'Experiencia del cliente en el punto'], ['crm', 'Disciplina del equipo con el CRM']
];
const ESCALA = ['', 'Deficiente', 'Requiere refuerzo', 'Aceptable', 'Bueno', 'Excelente'];
function parseJSON(s, def) { try { return s ? JSON.parse(s) : def; } catch (e) { return def; } }
function segsDe(nombre) {
  return (S.data.seguimientos || []).filter(s => norm(s.evaluado) === norm(nombre)).sort((a, b) => (parseFecha(b.fecha) || 0) - (parseFecha(a.fecha) || 0));
}
function indicadoresDe(tipo, evaluado, sede, mes) {
  const cfg = S.M.cfg;
  const ls = S.M.leads.filter(l => l.asign && ym(l.asign) === mes && (tipo === 'Asesor' ? norm(l.asesor) === norm(evaluado) : l.sede === sede));
  const facts = (S.data.facturas || []).filter(f => mesKey(f.fecha) === mes && (tipo === 'Asesor' ? norm(f.asesor) === norm(evaluado) : sedeCanon(f.sede) === sede));
  const meta = (S.data.metas || []).find(m => mesKey(m.mes) === mes && (tipo === 'Asesor' ? mismaPersona(m.persona, evaluado) : sedeCanon(m.persona) === sede));
  const con = ls.filter(l => l.hPrimera !== null);
  const t = con.map(l => l.hPrimera).sort((a, b) => a - b);
  const perd = ls.filter(l => l.estado === 'Perdido');
  const motivo = contar(perd, l => l.motivo || 'Sin motivo')[0];
  const cot = ls.filter(l => l.cotizado || ['Cotizado', 'Facturado'].includes(l.estado)).length;
  return [
    { k: 'asignados', t: 'Leads asignados', v: ls.length },
    { k: 'contacto', t: `Contactados ≤ ${cfg.sla_preventiva_h} h hábil`, v: fmtPct(pct(con.filter(l => l.aTiempo).length, ls.length)), s: semaPct(pct(con.filter(l => l.aTiempo).length, ls.length)) },
    { k: 'primera', t: '1ª respuesta (mediana)', v: fmtHoras(t.length ? t[Math.floor(t.length / 2)] : null) },
    { k: 'vencidos', t: 'Leads con SLA vencido hoy', v: ls.filter(l => l.sla === 'bad').length, s: ls.filter(l => l.sla === 'bad').length ? 'bad' : 'ok' },
    { k: 'cotizados', t: 'Cotizados / conversión', v: `${cot} · ${fmtPct(pct(cot, ls.length))}` },
    { k: 'facturados', t: 'Motos facturadas vs meta', v: `${facts.length}${meta ? ' / ' + num(meta.meta_motos) : ' / sin meta'}`, s: meta ? semaPct(pct(facts.length, num(meta.meta_motos))) : 'na' },
    { k: 'perdidos', t: 'Perdidos (motivo principal)', v: `${perd.length}${motivo ? ' · ' + motivo.l : ''}` },
    { k: 'incons', t: 'Inconsistencias abiertas', v: ls.filter(l => l.incons.length).length, s: ls.filter(l => l.incons.length).length ? 'warn' : 'ok' }
  ];
}
function semaPct(p) { return p === null ? 'na' : p >= 80 ? 'ok' : p >= 50 ? 'warn' : 'bad'; }

function vSeguimientos() {
  const u = S.data.user, M = S.M, F = S.segFiltro;
  const existe = !!S.data.hojas.Seguimientos;
  const todos = (S.data.seguimientos || []).slice().sort((a, b) => (parseFecha(b.fecha) || 0) - (parseFecha(a.fecha) || 0));
  const lista = todos.filter(s => (!F.tipo || s.tipo === F.tipo) && (!F.mes || mesKey(s.fecha) === F.mes) && (!F.sede || sedeCanon(s.sede) === F.sede) && (!F.evaluado || s.evaluado === F.evaluado));
  const freq = M.cfg.seguimiento_frecuencia_dias;
  const equipo = M.asesores.filter(p => u.rol === 'jefe' || p.sedeCanon === u.sede);
  // Un compromiso se cierra cuando el seguimiento siguiente lo califica como cumplido.
  const cerrados = new Set();
  todos.forEach(s => { const ev = parseJSON(s.evaluacion_json, {}); (ev.compromisos_previos || []).forEach(c => { if (c.estado === 'cumplido') cerrados.add(ev.seguimiento_anterior + '|' + c.accion); }); });
  const revisados = new Set(todos.map(s => parseJSON(s.evaluacion_json, {}).seguimiento_anterior).filter(Boolean));
  const compromisosPend = [];
  todos.forEach(s => parseJSON(s.compromisos_json, []).forEach(c => {
    if (!c.cumplido && !cerrados.has(s.id_seguimiento + '|' + c.accion)) compromisosPend.push(Object.assign({ evaluado: s.evaluado, seg: s.id_seguimiento, revisado: revisados.has(s.id_seguimiento) }, c));
  }));
  const vencidos = compromisosPend.filter(c => c.fecha && parseFecha(c.fecha) < new Date());

  return `<div class="page-h"><div><h2>Seguimientos comerciales</h2><p class="muted small">Acompañamiento a asesores y puntos de venta: indicadores del CRM, evaluación, compromisos y plan de acción.</p></div>
      ${u.rol !== 'asesor' ? `<button class="btn btn-primary" data-act="nuevoSeg" ${existe ? '' : 'disabled'}><i class="ti ti-plus"></i> Nuevo seguimiento</button>` : ''}</div>
    ${!existe ? `<div class="notice bad" style="margin-bottom:12px"><i class="ti ti-table-off"></i><div>Falta la hoja <b>Seguimientos</b> en el Sheet. Es una solicitud al Sheet (columnas en Ajustes → Estado del Sheet). Hasta que exista no se pueden guardar seguimientos.</div></div>` : ''}
    ${u.rol !== 'asesor' ? `<div class="section-title"><i class="ti ti-users"></i>Estado del equipo</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Asesor</th><th>Punto</th><th>Último seguimiento</th><th class="r">Días</th><th class="r">Calificación</th><th class="r">Compromisos abiertos</th><th></th></tr></thead><tbody>
      ${equipo.map(p => {
        const ss = segsDe(p.nombre); const ul = ss[0]; const f = ul && parseFecha(ul.fecha);
        const dias = f ? Math.floor((new Date() - f) / 864e5) : null;
        const sem = dias === null ? 'na' : freq ? (dias > freq ? 'bad' : dias > freq * .8 ? 'warn' : 'ok') : 'na';
        const ab = compromisosPend.filter(c => norm(c.evaluado) === norm(p.nombre)).length;
        return `<tr><td><span class="sema ${sem}"></span>${esc(p.nombre)}</td><td>${esc(p.sedeCanon)}</td><td>${f ? fmtFecha(f, false) : '<span class="muted">Nunca</span>'}</td><td class="r num">${dias ?? '—'}</td><td class="r num">${ul && ul.calificacion ? esc(ul.calificacion) + '/10' : '—'}</td><td class="r num">${ab}</td>
          <td>${existe ? `<button class="btn btn-sm" data-act="nuevoSeg" data-tipo="Asesor" data-ev="${esc(p.nombre)}">Hacer</button>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="7" class="muted">Sin asesores en la hoja Equipo.</td></tr>'}
    </tbody></table></div>
    <p class="tiny muted">${freq ? `Semáforo: rojo si pasan más de ${freq} días sin seguimiento.` : 'Semáforo inactivo: define la frecuencia de seguimientos en Ajustes → Umbrales.'}</p>` : ''}
    ${vencidos.length ? `<div class="notice bad" style="margin-top:12px"><i class="ti ti-calendar-x"></i><div><b>${vencidos.length} compromiso(s) vencido(s)</b><br>${vencidos.slice(0, 6).map(c => `${esc(c.evaluado)}: ${esc(c.accion)} (${esc(c.fecha)})`).join('<br>')}</div></div>` : ''}
    <div class="section-title"><i class="ti ti-history"></i>Historial<span class="count">${lista.length}</span></div>
    <div class="filters">
      <select class="sel" data-sf="tipo">${opts(['Asesor', 'Punto de venta'], F.tipo, 'Todos los tipos')}</select>
      <select class="sel" data-sf="mes">${opts(uniq(todos.map(s => mesKey(s.fecha))).map(m => ({ v: m, t: fmtMes(m) })), F.mes, 'Todos los meses')}</select>
      ${u.rol === 'jefe' ? `<select class="sel" data-sf="sede">${opts(['Itagüí', 'Los Colores'], F.sede, 'Todos los puntos')}</select>` : ''}
      ${u.rol !== 'asesor' ? `<select class="sel" data-sf="evaluado">${opts(uniq(todos.map(s => s.evaluado)).sort(), F.evaluado, 'Todos')}</select>` : ''}
    </div>
    ${lista.length ? `<div class="list">${lista.map(s => {
      const comp = parseJSON(s.compromisos_json, []);
      return `<article class="lead" style="cursor:pointer" data-act="verSeg" data-id="${esc(s.id_seguimiento)}">
        <div class="lead-top"><div><div class="lead-name">${esc(s.evaluado)}</div><div class="lead-sub">${esc(s.tipo)} · ${esc(sedeCanon(s.sede))} · ${fmtMes(mesKey(s.periodo) || mesKey(s.fecha))}</div></div>
        <span class="pill ${num(s.calificacion) >= 8 ? 'pill-ok' : num(s.calificacion) >= 6 ? 'pill-warn' : s.calificacion ? 'pill-bad' : ''}">${s.calificacion ? esc(s.calificacion) + '/10' : 'Sin nota'}</span></div>
        <div class="small muted">${fmtFecha(parseFecha(s.fecha))} · por ${esc(s.evaluador || '')}</div>
        ${s.oportunidades ? `<div class="small"><b>Por mejorar:</b> ${esc(String(s.oportunidades).slice(0, 140))}</div>` : ''}
        <div class="small">${comp.length} compromiso(s) · ${comp.filter(c => c.cumplido).length} cumplido(s)</div></article>`;
    }).join('')}</div>` : empty('ti-clipboard-off', u.rol === 'asesor' ? 'Aún no tienes seguimientos registrados.' : 'Sin seguimientos con estos filtros.')}`;
}

function formSeguimiento(tipo, evaluado) {
  const u = S.data.user, M = S.M;
  tipo = tipo || 'Asesor';
  const equipo = M.asesores.filter(p => u.rol === 'jefe' || p.sedeCanon === u.sede);
  const sedes = u.rol === 'jefe' ? ['Itagüí', 'Los Colores'] : [u.sede];
  if (!evaluado) evaluado = tipo === 'Asesor' ? (equipo[0] || {}).nombre || '' : sedes[0];
  const sede = tipo === 'Asesor' ? ((equipo.find(p => p.nombre === evaluado) || {}).sedeCanon || '') : evaluado;
  const mes = S.segMes || mesesRecientes(1)[0];
  const ind = indicadoresDe(tipo, evaluado, sede, mes);
  const items = tipo === 'Asesor' ? EVAL_ASESOR : EVAL_PUNTO;
  const previo = segsDe(evaluado)[0];
  const prevComp = previo ? parseJSON(previo.compromisos_json, []) : [];
  S.segDraft = { tipo, evaluado, sede, mes, ind, prevId: previo && previo.id_seguimiento, prevComp };

  abrirSheet(`<div class="sheet-h"><div><h2>Nuevo seguimiento</h2><div class="muted small">Se guarda en la hoja Seguimientos con tu nombre como evaluador.</div></div><button class="icon-btn" data-close><i class="ti ti-x"></i></button></div>
  <div class="sheet-b">
    <div class="card grid g3">
      <div><label class="f">Tipo</label><select class="sel w100" id="sg-tipo">${opts(['Asesor', 'Punto de venta'], tipo)}</select></div>
      <div><label class="f">${tipo === 'Asesor' ? 'Asesor' : 'Punto'}</label><select class="sel w100" id="sg-ev">${opts(tipo === 'Asesor' ? equipo.map(p => p.nombre) : sedes, evaluado)}</select></div>
      <div><label class="f">Período</label><select class="sel w100" id="sg-mes">${opts(mesesRecientes(6).map(m => ({ v: m, t: fmtMes(m) })), mes)}</select></div>
    </div>
    <div class="card"><div class="card-h"><h3>1. Indicadores del CRM</h3><span class="tiny muted">Autollenados · ${esc(sede)}</span></div>
      ${ind.map(i => `<div class="ind"><span>${i.s ? `<span class="sema ${i.s}"></span>` : ''}${esc(i.t)}</span><span class="v">${esc(i.v)}</span>
        <div class="x"><select class="sel" data-ind="${i.k}"><option value="">Evaluar…</option><option>Buena práctica</option><option>Requiere mejora</option><option>En riesgo</option></select>
        <input class="inp" data-indobs="${i.k}" placeholder="Causa / acción inmediata (48 h)"></div></div>`).join('')}</div>
    ${prevComp.length ? `<div class="card"><h3 style="margin-bottom:6px">2. Compromisos del seguimiento anterior</h3><p class="tiny muted" style="margin:0 0 8px">${fmtFecha(parseFecha(previo.fecha), false)} · por ${esc(previo.evaluador)}</p>
      ${prevComp.map((c, i) => `<div class="eval-row"><div class="small"><b>${esc(c.accion)}</b><br><span class="muted">${esc(c.responsable || '')} · ${esc(c.fecha || 'sin fecha')}</span></div>
        <select class="sel" data-prev="${i}"><option value="">¿Se cumplió?</option><option value="cumplido">Cumplido</option><option value="parcial">Parcial</option><option value="no">No cumplido</option></select></div>`).join('')}</div>` : ''}
    <div class="card"><h3 style="margin-bottom:4px">${prevComp.length ? 3 : 2}. Evaluación</h3><p class="tiny muted" style="margin:0 0 6px">1 = deficiente · 5 = excelente</p>
      ${items.map(([k, t]) => `<div class="eval-row"><div class="small">${t}</div><div class="score" data-score="${k}">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" title="${ESCALA[n]}">${n}</button>`).join('')}</div></div>`).join('')}</div>
    <div class="card stack"><h3>Plan de acción y compromisos</h3>
      <div><label class="f">Fortalezas identificadas</label><textarea class="inp" id="sg-fort"></textarea></div>
      <div><label class="f">Oportunidades de mejora prioritarias</label><textarea class="inp" id="sg-opor"></textarea></div>
      <div><label class="f">Compromisos (acción · responsable · fecha límite)</label><div id="sg-comp" class="stack-sm"></div>
        <button class="btn btn-sm" type="button" data-act="addComp" style="margin-top:6px"><i class="ti ti-plus"></i> Agregar compromiso</button></div>
      <div><label class="f">Observaciones generales</label><textarea class="inp" id="sg-obs"></textarea></div>
      <div class="grid g2"><div><label class="f">Calificación general (1–10)</label><input type="number" min="1" max="10" class="inp w100" id="sg-cal"></div>
        <div><label class="f">Próximo seguimiento</label><input type="date" class="inp w100" id="sg-prox"></div></div>
    </div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-act="guardarSeg"><i class="ti ti-device-floppy"></i> Guardar seguimiento</button></div>
  </div>`);
  agregarCompromiso();
  $('#sg-tipo').onchange = e => formSeguimiento(e.target.value, '');
  $('#sg-ev').onchange = e => formSeguimiento(tipo, e.target.value);
  $('#sg-mes').onchange = e => { S.segMes = e.target.value; formSeguimiento(tipo, evaluado); };
}
function agregarCompromiso() {
  const div = document.createElement('div');
  div.className = 'grid g3';
  div.dataset.comp = '1';
  div.innerHTML = `<input class="inp" data-c="accion" placeholder="Acción comprometida"><input class="inp" data-c="responsable" placeholder="Responsable"><input class="inp" type="date" data-c="fecha">`;
  $('#sg-comp').appendChild(div);
}
async function guardarSeguimiento(btn) {
  const D = S.segDraft;
  const evaluacion = { items: {}, indicadores_eval: {}, compromisos_previos: [] };
  $$('[data-score]').forEach(s => { const on = $('button.on', s); if (on) evaluacion.items[s.dataset.score] = Number(on.dataset.n); });
  D.ind.forEach(i => {
    const e = $(`[data-ind="${i.k}"]`).value, o = $(`[data-indobs="${i.k}"]`).value.trim();
    if (e || o) evaluacion.indicadores_eval[i.k] = { evaluacion: e, observacion: o };
  });
  D.prevComp.forEach((c, i) => { const v = $(`[data-prev="${i}"]`).value; evaluacion.compromisos_previos.push({ accion: c.accion, estado: v }); });
  evaluacion.seguimiento_anterior = D.prevId || '';
  const compromisos = $$('[data-comp]').map(r => ({
    accion: $('[data-c=accion]', r).value.trim(), responsable: $('[data-c=responsable]', r).value.trim(), fecha: $('[data-c=fecha]', r).value, cumplido: false
  })).filter(c => c.accion);
  const cal = num($('#sg-cal').value);
  if (cal !== null && (cal < 1 || cal > 10)) { toast('La calificación va de 1 a 10.', 'bad'); return; }
  if (!Object.keys(evaluacion.items).length && !compromisos.length && !$('#sg-obs').value.trim()) { toast('Completa al menos la evaluación, un compromiso u observaciones.', 'bad'); return; }
  btn.disabled = true;
  try {
    const indicadores = {}; D.ind.forEach(i => { indicadores[i.k] = { titulo: i.t, valor: i.v }; });
    await api('seguimiento', { seguimiento: {
      tipo: D.tipo, evaluado: D.evaluado, sede: D.sede, periodo: D.mes, calificacion: cal ?? '',
      indicadores, evaluacion, fortalezas: $('#sg-fort').value.trim(), oportunidades: $('#sg-opor').value.trim(),
      compromisos, observaciones: $('#sg-obs').value.trim(), proximo_seguimiento: $('#sg-prox').value
    } });
    cerrarSheet(); toast('Seguimiento guardado', 'ok'); await cargar(true);
  } catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
}
function verSeguimiento(id) {
  const s = (S.data.seguimientos || []).find(x => x.id_seguimiento === id);
  if (!s) return;
  const ind = parseJSON(s.indicadores_json, {}), ev = parseJSON(s.evaluacion_json, {}), comp = parseJSON(s.compromisos_json, []);
  const items = s.tipo === 'Asesor' ? EVAL_ASESOR : EVAL_PUNTO;
  abrirSheet(`<div class="sheet-h"><div><h2>${esc(s.evaluado)}</h2><div class="muted small">${esc(s.tipo)} · ${esc(sedeCanon(s.sede))} · ${fmtMes(mesKey(s.periodo) || mesKey(s.fecha))}</div></div>
    <div class="row"><button class="icon-btn no-print" data-act="imprimir" title="Imprimir / PDF"><i class="ti ti-printer"></i></button><button class="icon-btn no-print" data-close><i class="ti ti-x"></i></button></div></div>
  <div class="sheet-b">
    <div class="row wrap"><span class="pill pill-dark">${s.calificacion ? esc(s.calificacion) + '/10' : 'Sin calificación'}</span><span class="pill">${fmtFecha(parseFecha(s.fecha))}</span><span class="pill">Evaluador: ${esc(s.evaluador)}</span>${s.proximo_seguimiento ? `<span class="pill pill-info">Próximo: ${esc(String(s.proximo_seguimiento).slice(0, 10))}</span>` : ''}</div>
    <div class="card"><h3 style="margin-bottom:6px">Indicadores al momento del seguimiento</h3>${Object.keys(ind).map(k => { const e = (ev.indicadores_eval || {})[k] || {}; return `<div class="ind"><span>${esc(ind[k].titulo)}</span><span class="v">${esc(ind[k].valor)}</span>${e.evaluacion || e.observacion ? `<div class="x small"><span class="pill ${e.evaluacion === 'Buena práctica' ? 'pill-ok' : e.evaluacion === 'En riesgo' ? 'pill-bad' : 'pill-warn'}">${esc(e.evaluacion || '—')}</span><span>${esc(e.observacion || '')}</span></div>` : ''}</div>`; }).join('') || '<p class="small muted">Sin indicadores.</p>'}</div>
    ${(ev.compromisos_previos || []).length ? `<div class="card"><h3 style="margin-bottom:6px">Compromisos anteriores</h3>${ev.compromisos_previos.map(c => `<div class="small" style="padding:4px 0">${esc(c.accion)} — <b>${esc({ cumplido: 'Cumplido', parcial: 'Parcial', no: 'No cumplido' }[c.estado] || 'Sin revisar')}</b></div>`).join('')}</div>` : ''}
    <div class="card"><h3 style="margin-bottom:6px">Evaluación</h3>${items.filter(([k]) => (ev.items || {})[k]).map(([k, t]) => `<div class="eval-row"><span class="small">${t}</span><b class="small">${ev.items[k]} · ${ESCALA[ev.items[k]]}</b></div>`).join('') || '<p class="small muted">Sin evaluación cualitativa.</p>'}</div>
    <div class="card stack-sm">${s.fortalezas ? `<div><h4>Fortalezas</h4><p class="small" style="margin:4px 0;white-space:pre-wrap">${esc(s.fortalezas)}</p></div>` : ''}${s.oportunidades ? `<div><h4>Oportunidades de mejora</h4><p class="small" style="margin:4px 0;white-space:pre-wrap">${esc(s.oportunidades)}</p></div>` : ''}${s.observaciones ? `<div><h4>Observaciones</h4><p class="small" style="margin:4px 0;white-space:pre-wrap">${esc(s.observaciones)}</p></div>` : ''}</div>
    <div class="card"><h3 style="margin-bottom:6px">Compromisos</h3>${comp.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Acción</th><th>Responsable</th><th>Fecha</th></tr></thead><tbody>${comp.map(c => `<tr><td style="white-space:normal">${esc(c.accion)}</td><td>${esc(c.responsable)}</td><td>${esc(c.fecha)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">Sin compromisos.</p>'}</div>
  </div>`);
}

// ── Vista: Conciliación (Jefe) ────────────────────────────────────────────
function vConciliacion() {
  const M = S.M;
  const incons = M.leads.filter(l => l.incons.some(i => i.startsWith('Marcado cotizado') || i.startsWith('Inconsistencia')));
  const pendFact = M.leads.filter(l => l.estado === 'Facturado' && !l.fac.length);
  const tabs = [
    ['incons', 'Inconsistencias', incons.length], ['pendfact', 'Pendientes de facturar', pendFact.length],
    ['sinorigen', 'Ventas fuera del bot', M.facSinOrigen.length]
  ];
  let body = '';
  if (S.concTab === 'incons') body = incons.length ? `<div class="list">${incons.map(leadCard).join('')}</div>` : empty('ti-circle-check', 'Sin inconsistencias.');
  if (S.concTab === 'pendfact') body = pendFact.length ? `<p class="small muted">Leads que el asesor marcó como vendidos y que todavía no aparecen en las ventas de Síntesis. Se cruzan solos por celular cuando las ventas de Síntesis están en el repositorio de Metas y Cifras.</p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Lead</th><th>Asesor</th><th>Punto</th><th>Modelo</th><th>Marcado</th></tr></thead><tbody>${pendFact.map(l => `<tr><td><a href="#" data-act="abrir" data-id="${esc(l.id)}">${esc(l.nombre)}</a></td><td>${esc(l.asesor)}</td><td>${esc(l.sede)}</td><td>${esc(l.raw.modelo_interes || '')}</td><td>${fmtFecha(l.ultimaAct, false)}</td></tr>`).join('')}</tbody></table></div>` : empty('ti-circle-check', 'Todo lo marcado como vendido aparece en las ventas.');
  if (S.concTab === 'sinorigen') body = M.facSinOrigen.length ? `<p class="small muted">Ventas facturadas (Síntesis) cuyo celular no coincide con ningún lead del bot: clientes que llegaron por otros canales o que no pasaron por el bot.</p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Factura</th><th>Fecha</th><th>Asesor</th><th>Punto</th><th>Moto</th><th class="r">Valor</th></tr></thead><tbody>${M.facSinOrigen.slice(0, 300).map(f => `<tr><td>${esc(f.id_factura)}</td><td>${fmtFecha(parseFecha(f.fecha), false)}</td><td>${esc(f.asesor)}</td><td>${esc(f.sede)}</td><td>${esc(f.modelo)}</td><td class="r num">${money(num(f.valor))}</td></tr>`).join('')}</tbody></table></div>` : empty('ti-circle-check', 'Todas las ventas cargadas vinieron del bot (o aún no hay ventas cargadas).');
  return `<div class="page-h"><div><h2>Conciliación</h2><p class="muted small">Cruce entre lo que marca el asesor y la evidencia del CRM de la empresa.</p></div></div>
    <div class="seg" style="margin-bottom:12px">${tabs.map(t => `<button class="${S.concTab === t[0] ? 'on' : ''}" data-tab="concTab" data-v="${t[0]}">${t[1]} (${t[2]})</button>`).join('')}</div>${body}`;
}

// ── Vista: Configuración (Jefe) ───────────────────────────────────────────
const UMBRALES = [
  ['sla_preventiva_h', 'Alerta preventiva sin contacto (horas hábiles)', '1 (brief)'],
  ['sla_vencida_h', 'SLA vencido sin contacto (horas hábiles)', '3 (brief)'],
  ['sin_cotizar_h', 'Contactado sin cotizar (horas hábiles)', '20 (brief)'],
  ['cotizado_sin_avance_dias', 'Cotizado sin avance (días)', 'pendiente de definir'],
  ['escalamiento_horas', 'Escalar al Jefe a las (horas hábiles)', 'pendiente de definir'],
  ['escalamiento_destinatario', 'Escalar a (correo o nombre)', 'pendiente de definir'],
  ['seguimiento_frecuencia_dias', 'Frecuencia de seguimientos comerciales (días)', 'pendiente de definir']
];
const COLS_OPCIONALES = {
  Leads: ['telefono_contacto', 'estado_crm'], Gestion_Asesor: ['fecha_contactado'], Cotizaciones: ['id_contacto']
};
const CARGAS = {
  Cotizaciones: { req: ['id_cotizacion', 'fecha'], uno: ['telefono_lead', 'id_contacto'] },
  Facturas: { req: ['id_factura', 'fecha', 'valor', 'asesor', 'sede'], uno: [] },
  Metas: { req: ['persona', 'mes', 'meta_motos'], uno: [] }
};
// ═══════════════════════════════ ACCESOS (solo Jefe Comercial) ═══════════
// Enlaces a las plataformas del proyecto. Para agregar uno nuevo, añade una línea aquí.
const ACCESOS = [
  { grupo: 'Para clientes', icon: 'ti-calculator', nombre: 'Cotizador de motos (público)', desc: 'Enlace para publicaciones en redes y para enviar por WhatsApp. Quien cotiza entra como lead caliente "cotizado" con su perfil (forma de pago, actividad, centrales de riesgo).', url: 'https://orregomejiaj-gif.github.io/crm-leads-motos/cotizador.html' },
  { grupo: 'Para clientes', icon: 'ti-motorbike', nombre: 'Catálogo de motos (público)', desc: 'Todas las motos con precio, bono vigente y ficha técnica. Cada moto lleva al cotizador.', url: 'https://orregomejiaj-gif.github.io/crm-leads-motos/catalogo.html' },
  { grupo: 'Para clientes', icon: 'ti-brand-whatsapp', nombre: 'Cotizador con datos precargados (WhatsApp)', desc: 'Plantilla para enviar a un cliente: cambia el celular (c), el nombre (n) y la moto (m) en el enlace. Lo usan el bot y los asesores.', url: 'https://orregomejiaj-gif.github.io/crm-leads-motos/cotizador.html?c=573000000000&n=Nombre&m=NKD%20125' },
  { grupo: 'Para clientes', icon: 'ti-chart-bar', nombre: 'Encuesta de satisfacción (cliente)', desc: 'La página que abre el botón «Responder encuesta» de las plantillas de WhatsApp. Necesita un token por cliente: no se comparte suelta.', url: 'https://orregomejiaj-gif.github.io/crm-leads-motos/encuesta.html' },
  { grupo: 'Para eventos', icon: 'ti-calendar-event', nombre: 'Recolector de leads para eventos', desc: 'Formulario rápido para ferias y activaciones. Añade ?e=NombreDelEvento al enlace para etiquetar la campaña; los leads quedan con origen «Evento (cotizador)».', url: 'https://orregomejiaj-gif.github.io/crm-leads-motos/cotizador-eventos.html' },
  { grupo: 'Para eventos', icon: 'ti-calendar-event', nombre: 'Recolector de leads · ejemplo con evento', desc: 'Enlace listo para copiar: cambia «Evento» por el nombre de la feria o activación.', url: 'https://orregomejiaj-gif.github.io/crm-leads-motos/cotizador-eventos.html?e=Evento' },
  { grupo: 'La app', icon: 'ti-layout-dashboard', nombre: 'IC Leads (esta app)', desc: 'Enlace de acceso para el equipo comercial.', url: 'https://orregomejiaj-gif.github.io/crm-leads-motos/' },
  { grupo: 'Datos y repositorios', icon: 'ti-table', nombre: 'Libro principal · Leads, Equipo y Precios', desc: 'AKT-Hero Bot - CRM: precios con bonos, existencias, sedes, personal, leads, perfiles y pauta.', url: 'https://docs.google.com/spreadsheets/d/19JmIvjvafMULmiLhwwwD-tQD_xmENUjbuJegA0wxQOE/edit' },
  { grupo: 'Datos y repositorios', icon: 'ti-table', nombre: 'Cotizaciones (Mes_en_Curso e Histórico)', desc: 'Aquí se pega la exportación mensual de cotizaciones del CRM.', url: 'https://docs.google.com/spreadsheets/d/1LBNF-zkfHdILsSJncFr_V0xTEVEVeiFemA-l_MOF8bc/edit' },
  { grupo: 'Datos y repositorios', icon: 'ti-table', nombre: 'Metas y cifras comerciales (ventas)', desc: 'Metas, ventas del mes (Mes_en_Curso), histórico y referencias más vendidas.', url: 'https://docs.google.com/spreadsheets/d/1w3fRZMVNKwOy6zGMF-KtA5uhAr8ZhpUOyPYqd8mZN_E/edit' },
  { grupo: 'Datos y repositorios', icon: 'ti-table', nombre: 'Inventario (motos y repuestos por punto)', desc: 'Existencias de Itagüí y Los Colores, pendientes por llegar y facturación.', url: 'https://docs.google.com/spreadsheets/d/1EvMbR4faVKzUk_jdx7w8kGXnlv3T16_sg6FT_j8zCpU/edit' },
  { grupo: 'Datos y repositorios', icon: 'ti-table', nombre: 'Posventa', desc: 'Seguimiento de posventa y entregas.', url: 'https://docs.google.com/spreadsheets/d/13ZPpoBB1EBhybvA1wAzhnMPX6yAkh_bFPGCa_2pXyDE/edit' },
  { grupo: 'Datos y repositorios', icon: 'ti-table', nombre: 'Seguimientos comerciales', desc: 'Repositorio de seguimientos comerciales.', url: 'https://docs.google.com/spreadsheets/d/1vneSkeNVGKdq7mUkNc-i_R7l9Zbm3eM1Mj8YC_NCGs0/edit' },
  { grupo: 'Datos y repositorios', icon: 'ti-file-text', nombre: 'Inventario de repositorios y conexiones', desc: 'Documento con el mapa de archivos y conexiones del proyecto.', url: 'https://docs.google.com/document/d/1rgBSEFyTb5ozwWURSoqnIOF8U_NWnnBJy-dfz4zoJbI/edit' },
  { grupo: 'Datos y repositorios', icon: 'ti-folder', nombre: 'Carpeta AKT en Drive', desc: 'Todos los archivos del proyecto.', url: 'https://drive.google.com/drive/folders/1wwIioksMWqpkDF1uK1kQp-kFbOq0xYrp' },
  { grupo: 'Automatización y plataformas', icon: 'ti-code', nombre: 'API · Apps Script', desc: 'Código del servidor (Code.gs), propiedades del script e implementaciones.', url: 'https://script.google.com/home/projects/1R2koM-gUZLlQ6huxcStTdkJe4osmV_HwC8bXhGtWpS42sm45-9wKWp7A/edit' },
  { grupo: 'Automatización y plataformas', icon: 'ti-robot', nombre: 'n8n · bot Mateo', desc: 'Flujo principal de WhatsApp con IA.', url: 'https://akt-n8n-bot.duckdns.org/workflow/zcDMAunoJnlVBgNv' },
  { grupo: 'Automatización y plataformas', icon: 'ti-brand-whatsapp', nombre: 'WhatsApp Manager · plantillas', desc: 'Plantillas de mensaje, número +57 350 2683788 y catálogo de WhatsApp.', url: 'https://business.facebook.com/latest/whatsapp_manager/message_templates?business_id=1159412020597911&asset_id=1505068428047318' },
  { grupo: 'Pauta Meta', icon: 'ti-speakerphone', nombre: 'PAUTA ITAGUI · Administrador de anuncios', desc: 'Cuenta publicitaria 3229748370556571 (portfolio Motoracing AKT Itagüí santa maría). Exporta de aquí el informe semanal para la hoja Pauta_Meta con punto = Itagüí.', url: 'https://adsmanager.facebook.com/adsmanager/manage/adsets?act=3229748370556571' },
  { grupo: 'Pauta Meta', icon: 'ti-speakerphone', nombre: 'PAUTA LOS COLORES · Administrador de anuncios', desc: 'Cuenta publicitaria 1779823606539913 (portfolio AKT MotoRacing Los Colores). Exporta de aquí el informe semanal para la hoja Pauta_Meta con punto = Los Colores.', url: 'https://adsmanager.facebook.com/adsmanager/manage/adsets?act=1779823606539913' },
  { grupo: 'Automatización y plataformas', icon: 'ti-world', nombre: 'Sitio web Moto Racing', desc: 'motoracing.com.co: de aquí salen las fichas técnicas del catálogo.', url: 'https://motoracing.com.co/' }
];
/** Mapa de zonas (solo Jefe): de qué municipios llegan los leads (Medellín + 65 km) y qué punto atiende cada zona. */
function cargarZonas() {
  if (S.zonBusy) return; S.zonBusy = true;
  api('zonas', { dias: S.zonDias === undefined ? 90 : S.zonDias }).then(r => { S.zon = r; S.zonErr = ''; S.zonT = Date.now(); }).catch(e => { S.zonErr = e.message; S.zonT = Date.now(); })
    .finally(() => { S.zonBusy = false; if (S.view === 'zonas') render(); });
}
function vZonas() {
  if (S.data.user.rol !== 'jefe') return empty('ti-lock', 'Solo el Jefe Comercial ve el mapa de zonas.');
  if ((!S.zon && Date.now() - (S.zonT || 0) > 20e3) || (S.zon && Date.now() - (S.zonT || 0) > 120e3)) cargarZonas();
  const sel = `<select class="sel" data-ch="zonDias">${[[30, 'Últimos 30 días'], [90, 'Últimos 90 días'], [0, 'Todo el histórico']].map(([v, t]) => `<option value="${v}" ${(S.zonDias === undefined ? 90 : S.zonDias) === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  if (!S.zon) return `<div class="page-h"><div><h2>Zonas de origen de los leads</h2></div>${sel}</div>` + (S.zonErr ? `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div>${esc(S.zonErr)}</div></div>` : '<div class="loading"><div><i class="ti ti-loader-2 spin"></i> Ubicando los leads en el mapa…</div></div>');
  const R = S.zon, F = (R.filas || []).filter(f => f.leads), conZona = F.filter(f => f.lat !== null && f.lat !== undefined), total = F.reduce((s, f) => s + Number(f.leads), 0);
  const sinZona = F.filter(f => f.municipio === 'Sin zona').reduce((s, f) => s + Number(f.leads), 0), otra = F.filter(f => /^Otra zona/.test(f.municipio)).reduce((s, f) => s + Number(f.leads), 0);
  const ubic = conZona.reduce((s, f) => s + Number(f.leads), 0), pct = (a, b) => b ? Math.round(a * 100 / b) + '%' : '—';
  const porPunto = p => conZona.filter(f => f.punto === p).reduce((s, f) => s + Number(f.leads), 0);
  const top = conZona[0];
  // Mapa esquemático (sin depender de internet): Medellín al centro y el anillo de 65 km
  const K = 3.5, cx = 300, cy = 262, X = f => cx + (Number(f.lon) + 75.5636) * 110.5 * K, Y = f => cy - (Number(f.lat) - 6.2518) * 110.6 * K;
  const cnt = {}; conZona.forEach(f => { cnt[f.municipio] = f; });
  const todas = (R.zonas || []).map(z => ({ z, f: cnt[z.municipio] })), mx = Math.max(1, ...conZona.map(f => Number(f.leads)));
  const color = p => p === 'Itagüí' ? '#1d4ed8' : '#ea580c';
  const burbujas = todas.map(({ z, f }) => { const n = f ? Number(f.leads) : 0, r = n ? 6 + Math.sqrt(n / mx) * 22 : 3.5;
    return `<g><circle cx="${X(z).toFixed(1)}" cy="${Y(z).toFixed(1)}" r="${r.toFixed(1)}" fill="${n ? color(z.punto) : '#94a3b8'}" fill-opacity="${n ? .55 : .5}" stroke="${n ? color(z.punto) : '#64748b'}"><title>${esc(z.municipio)} · ${n} lead${n === 1 ? '' : 's'} · punto ${esc(z.punto)}</title></circle>${n ? `<text x="${X(z).toFixed(1)}" y="${(Y(z) - r - 3).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#0f172a">${esc(z.municipio)} ${n}</text>` : ''}</g>`; }).join('');
  const mapa = `<svg viewBox="0 0 600 524" style="width:100%;max-width:640px;background:#f8fafc;border-radius:14px;border:1px solid #e2e8f0"><circle cx="${cx}" cy="${cy}" r="${65 * K}" fill="#e0f2fe" fill-opacity=".45" stroke="#38bdf8" stroke-dasharray="6 5"/><circle cx="${cx}" cy="${cy}" r="${30 * K}" fill="none" stroke="#bae6fd" stroke-dasharray="3 5"/><text x="${cx}" y="${cy - 65 * K - 6}" text-anchor="middle" font-size="11" fill="#0369a1">65 km de Medellín</text>${burbujas}<text x="14" y="512" font-size="11" fill="#475569">● azul = Itagüí · ● naranja = Los Colores · gris = sin leads aún (tamaño = cantidad)</text></svg>`;
  const barras = conZona.slice(0, 15).map(f => `<div style="display:flex;align-items:center;gap:8px;margin:4px 0"><div style="width:190px;font-size:.86rem"><b>${esc(f.municipio)}</b> <span class="tiny muted">${f.km === null ? '' : f.km + ' km'}</span></div><div style="flex:1;background:#eef2f7;border-radius:6px;height:16px"><div style="width:${Math.max(3, Number(f.leads) * 100 / mx)}%;height:16px;border-radius:6px;background:${color(f.punto)}"></div></div><div style="width:150px;font-size:.82rem"><b>${f.leads}</b> · 🔥${f.calientes} · 📅${f.con_cita} · 💰${f.ventas}</div></div>`).join('');
  const reg = {}; conZona.forEach(f => { const g = reg[f.region] || (reg[f.region] = { region: f.region, leads: 0, calientes: 0, citas: 0, ventas: 0, pauta: 0 }); g.leads += Number(f.leads); g.calientes += Number(f.calientes); g.citas += Number(f.con_cita); g.ventas += Number(f.ventas); g.pauta += Number(f.de_pauta); });
  const regs = Object.values(reg).sort((a, b) => b.leads - a.leads);
  const fuera = (R.sin || []);
  const ia = [];
  if (top) ia.push(`📍 La zona que más leads trae es <b>${esc(top.municipio)}</b> (${top.leads}, ${pct(top.leads, ubic)} de los ubicados).`);
  if (regs[0]) ia.push(`🗺️ Por región manda <b>${esc(regs[0].region)}</b> con ${pct(regs[0].leads, ubic)} de los leads.`);
  const lejos = conZona.filter(f => f.km !== null && f.km > 40).reduce((s, f) => s + Number(f.leads), 0);
  if (ubic) ia.push(`🚗 ${pct(lejos, ubic)} de los leads viven a más de 40 km de Medellín: si la campaña apunta al área metropolitana, revisa la segmentación geográfica.`);
  if (sinZona + otra) ia.push(`❓ ${sinZona + otra} lead${sinZona + otra === 1 ? '' : 's'} sin zona útil: Mateo debe preguntarla antes de asignar.`);
  return `<div class="page-h"><div><h2>Zonas de origen de los leads</h2><p class="muted small">Medellín + 65 km · dónde vive quien escribe y qué punto lo atiende. Sirve para afinar a dónde apuntan las campañas.</p></div>${sel}</div>
    <div class="grid g-kpi">${kpi('📥 Leads', total, 'en el periodo')}${kpi('📍 Ubicados', pct(ubic, total), ubic + ' con municipio')}${kpi('🔵 Punto Itagüí', porPunto('Itagüí'), pct(porPunto('Itagüí'), ubic) + ' de los ubicados')}${kpi('🟠 Punto Los Colores', porPunto('Los Colores'), pct(porPunto('Los Colores'), ubic) + ' de los ubicados')}</div>
    ${ia.length ? `<div class="notice"><i class="ti ti-bulb"></i><div>${ia.join('<br>')}</div></div>` : ''}
    <div class="card"><div class="card-h"><h3>Mapa</h3></div><div style="text-align:center">${mapa}</div></div>
    <div class="card"><div class="card-h"><h3>Municipios con más leads</h3><span class="tiny muted">leads · 🔥 calientes · 📅 con cita · 💰 ventas</span></div>${barras || '<p class="small muted">Aún no hay leads con zona.</p>'}</div>
    <div class="card"><div class="card-h"><h3>Por región</h3></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Región</th><th>Leads</th><th>% </th><th>Calientes</th><th>Con cita</th><th>Ventas</th><th>De pauta</th></tr></thead><tbody>${regs.map(g => `<tr><td><b>${esc(g.region)}</b></td><td>${g.leads}</td><td>${pct(g.leads, ubic)}</td><td>${g.calientes}</td><td>${g.citas}</td><td>${g.ventas}</td><td>${g.pauta}</td></tr>`).join('') || '<tr><td colspan="7" class="muted small">Sin datos todavía.</td></tr>'}</tbody></table></div></div>
    ${fuera.length ? `<div class="card"><div class="card-h"><h3>Zonas que no se pudieron ubicar</h3><span class="tiny muted">se agregan en la tabla zonas_cobertura</span></div><div class="small">${fuera.map(x => `<span class="pill" style="margin:2px">${esc(x.zona)} · ${x.leads}</span>`).join('')}</div></div>` : ''}`;
}
/** Disponibilidad del equipo (solo Jefe): «no disponible» saca a la persona de la rotación automática de leads hasta la hora elegida. */
function disponibilidadDe(p) {
  const t = Date.parse(String(p.no_disponible_hasta || '').trim());
  if (!t || t <= Date.now()) return { ok: true };
  return { ok: false, hasta: t, indef: new Date(t).getFullYear() >= 2900, motivo: String(p.motivo_no_disponible || '') };
}
function vDisponibilidad() {
  if (S.data.user.rol !== 'jefe') return empty('ti-lock', 'Solo el Jefe Comercial maneja la disponibilidad del equipo.');
  const eq = (S.M.personas || []).filter(p => p.nombre && !/vacante/i.test(p.nombre) && p.rolApp !== 'jefe' && (!p.activo || norm(p.activo).startsWith('si')) && !/call\s*center|callcenter/.test(norm(p.cargo)) && !/manual/.test(norm(p.recibe)))
    .sort((a, b) => String(a.sedeCanon).localeCompare(String(b.sedeCanon)) || String(a.nombre).localeCompare(String(b.nombre)));
  const fmt = t => new Date(t).toLocaleString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const filas = eq.map(p => {
    const d = disponibilidadDe(p);
    return `<div class="card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px"><b>${esc(p.nombre)}</b><div class="small muted">${esc(p.sedeCanon || p.nombre_punto || '')} · ${esc(p.cargo || '')}</div></div>
      <div>${d.ok ? '<span class="pill" style="background:#dcfce7;color:#166534"><i class="ti ti-circle-check"></i> Disponible · recibe leads</span>'
        : `<span class="pill" style="background:#fee2e2;color:#991b1b"><i class="ti ti-player-pause"></i> No disponible ${d.indef ? 'hasta que lo actives' : 'hasta ' + esc(fmt(d.hasta))}</span>${d.motivo ? `<div class="tiny muted">${esc(d.motivo)}</div>` : ''}`}</div>
      <div>${d.ok ? `<button class="btn btn-sm btn-dark" data-act="disp-abrir" data-nom="${esc(p.nombre)}"><i class="ti ti-user-off"></i> Marcar no disponible</button>`
        : `<button class="btn btn-sm btn-primary" data-act="disp-activar" data-nom="${esc(p.nombre)}"><i class="ti ti-user-check"></i> Volver a recibir leads</button>`}</div></div>`;
  }).join('');
  return `<div class="page-h"><div><h2>Disponibilidad del equipo</h2><p class="muted small">Apaga el ingreso de leads a quien esté ausente (vacaciones, incapacidad, reunión). Los leads nuevos se reparten solo entre quienes están disponibles; vuelve solo a la rotación cuando se cumple el tiempo. Kelly (call center) no recibe leads automáticos: se los asignas tú.</p></div></div>
    <div class="grid" style="gap:10px">${filas || empty('ti-users', 'No hay asesores configurados.')}</div>`;
}
function vAccesos() {
  if (S.data.user.rol !== 'jefe') return empty('ti-lock', 'Solo el Jefe Comercial ve los accesos.');
  const grupos = uniq(ACCESOS.map(a => a.grupo));
  return `<div class="page-h"><div><h2>Accesos</h2><p class="muted small">Enlaces a las plataformas del proyecto. Solo los ve el Jefe Comercial.</p></div></div>
    ${grupos.map(g => `<div class="section-title"><i class="ti ti-folder"></i>${esc(g)}</div>
      <div class="grid g2">${ACCESOS.filter(a => a.grupo === g).map(a => `<div class="card"><div class="row" style="gap:10px;align-items:flex-start"><i class="ti ${a.icon}" style="font-size:1.4rem;color:var(--brand,#0b2e6e)"></i>
        <div style="min-width:0;flex:1"><b>${esc(a.nombre)}</b><p class="small muted" style="margin:2px 0 8px">${esc(a.desc)}</p>
        <div class="small" style="word-break:break-all;margin-bottom:8px">${esc(a.url)}</div>
        <div class="row wrap" style="gap:6px"><a class="btn btn-sm btn-dark" href="${esc(a.url)}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> Abrir</a>
        <button class="btn btn-sm" data-act="copiar-acceso" data-url="${esc(a.url)}"><i class="ti ti-copy"></i> Copiar enlace</button></div></div></div></div>`).join('')}</div>`).join('')}`;
}

function vConfig() {
  const d = S.data, tab = S.cfgTab;
  const tabs = [['sheet', 'Estado del Sheet'], ['repos', 'Repositorios'], ['umbrales', 'Umbrales'], ['equipo', 'Equipo y accesos'], ['metas', 'Metas'], ['catalogos', 'Catálogos']];
  let body = '';
  if (tab === 'sheet') {
    const sol = d.solicitudes || {};
    body = `<div class="notice info" style="margin-bottom:12px"><i class="ti ti-info-circle"></i><div>La app no crea hojas ni columnas. Lo que falta aquí es una <b>solicitud al Sheet</b>: créalo en el Sheet (o corre <code>crearHojasSolicitadas()</code> desde el editor de Apps Script si lo apruebas).</div></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Hoja</th><th>Estado</th><th>Columnas solicitadas</th></tr></thead><tbody>
    ${Object.keys(sol).map(h => { const hs = d.hojas[h]; const falt = hs ? sol[h].filter(c => !hs.includes(c)) : sol[h];
      return `<tr><td><b>${h}</b></td><td>${!hs ? '<span class="pill pill-bad">No existe</span>' : falt.length ? '<span class="pill pill-warn">Faltan columnas</span>' : '<span class="pill pill-ok">OK</span>'}</td><td style="white-space:normal" class="small">${(hs ? falt : sol[h]).map(esc).join(', ') || '—'}</td></tr>`; }).join('')}
    ${Object.keys(COLS_OPCIONALES).map(h => { const hs = d.hojas[h] || []; const falt = COLS_OPCIONALES[h].filter(c => !hs.includes(c));
      return falt.length ? `<tr><td><b>${h}</b></td><td><span class="pill">Opcional</span></td><td style="white-space:normal" class="small">${falt.join(', ')}</td></tr>` : ''; }).join('')}
    </tbody></table></div>
    <p class="tiny muted">Opcionales: <code>Leads.telefono_contacto</code> (teléfono dicho en el chat), <code>Leads.estado_crm</code> (estado calculado por n8n; si existe, la app lo muestra en vez de calcularlo), <code>Gestion_Asesor.fecha_contactado</code> (hora exacta de contacto), <code>Cotizaciones.id_contacto</code> (cruce sin teléfono).</p>`;
  }
  if (tab === 'repos') body = MOD ? MOD.repoTab() : '';
  if (tab === 'umbrales') {
    const raw = S.M.cfg.raw;
    body = `${!d.hojas.Config_App ? '<div class="notice bad" style="margin-bottom:12px"><i class="ti ti-table-off"></i><div>Falta la hoja <b>Config_App</b>: se usan los valores del brief y los pendientes quedan inactivos.</div></div>' : ''}
    <div class="card stack">${UMBRALES.map(([k, t, ref]) => `<div class="grid g2" style="align-items:center"><div><b class="small">${t}</b><div class="tiny muted">Referencia: ${ref}</div></div><input class="inp" data-cfg="${k}" value="${esc(raw[k] ?? '')}" placeholder="${ref.includes('pendiente') ? 'Sin definir' : ref.split(' ')[0]}"></div>`).join('')}
      <p class="tiny muted" style="margin:0">Los cálculos de alertas los hace n8n cada 30 min; estos valores los usa la app para ordenar y resaltar, y quedan en Config_App para que n8n los lea.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-act="guardarCfg" ${d.hojas.Config_App ? '' : 'disabled'}>Guardar umbrales</button></div></div>`;
  }
  if (tab === 'equipo') {
    const ps = S.M.personas;
    const cols = (d.hojas.Equipo || ['CEDULA', 'nombre', 'cargo', 'nombre_punto', 'direccion', 'whatsapp', 'activo']).filter(c => c && !['marca', 'contrasena', 'password'].includes(norm(c)));
    const avisos = [];
    const ced = {}; ps.forEach(p => { const c = cedulaDe(p); if (c) (ced[c] = ced[c] || []).push(p.nombre); });
    Object.values(ced).filter(v => v.length > 1).forEach(v => avisos.push('Cédula repetida (no podrán entrar): ' + v.join(', ')));
    const sinCed = ps.filter(p => !cedulaDe(p)).map(p => p.nombre);
    if (sinCed.length) avisos.push('Sin cédula (no pueden entrar): ' + sinCed.join(', '));
    const wa = {}; ps.forEach(p => { if (p.whatsapp) (wa[digits(p.whatsapp)] = wa[digits(p.whatsapp)] || []).push(p.nombre); });
    Object.values(wa).filter(v => v.length > 1).forEach(v => avisos.push('Comparten WhatsApp (las alertas llegan al mismo número): ' + v.join(', ')));
    if (!ps.some(p => p.rolApp === 'admin')) avisos.push('No hay administradores de punto en Equipo (cargo que contenga “administrador”).');
    (d.sedes || []).filter(s => !s.direccion).forEach(s => avisos.push(`El punto ${s.nombre_punto} no tiene dirección en Equipo.`));
    body = `${avisos.map(a => `<div class="notice" style="margin-bottom:8px"><i class="ti ti-alert-triangle"></i><div>${esc(a)}</div></div>`).join('')}
      <div class="notice info" style="margin-bottom:10px"><i class="ti ti-key"></i><div><b>Acceso:</b> usuario = número de cédula · contraseña = la columna <code>CONTRASEÑA</code> de la hoja Equipo (si está vacía, <code>APP_PASSWORD</code>). Por seguridad la app no muestra ni edita contraseñas: se cambian directamente en el Sheet. Solo entran personas con <code>activo</code> = Si y un cargo que contenga “asesor”, “administrador” o “jefe” (o cuya cédula esté en <code>JEFE_CEDULAS</code>).</div></div>
      <p class="small muted">Haz clic en una celda para editarla; se guarda al salir de la celda y queda en la bitácora.</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}<th>Rol en la app</th></tr></thead><tbody>
      ${ps.map(p => `<tr>${cols.map(c => `<td contenteditable="true" data-edit="Equipo" data-row="${p._row}" data-field="${esc(c)}" data-orig="${esc(p[c] ?? '')}" style="min-width:90px">${esc(p[c] ?? '')}</td>`).join('')}<td>${p.rolApp && norm(p.activo || 'si').startsWith('si') ? `<span class="pill">${p.rolApp}</span>` : '<span class="muted tiny">sin acceso</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  if (tab === 'metas') {
    const ms = d.metas || [];
    body = !d.hojas.Metas ? empty('ti-table-off', 'La hoja Metas aún no existe (solicitud al Sheet).') : `<p class="small muted">Meta mensual por persona o punto. Para el punto, usa el nombre del punto en <code>persona</code>. Las metas viven en el repositorio «Metas y Cifras Comerciales»: edita las celdas aquí o agrega filas nuevas directamente en ese Sheet.</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr>${d.hojas.Metas.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${ms.map(m => `<tr>${d.hojas.Metas.map(c => `<td contenteditable="true" data-edit="Metas" data-row="${m._row}" data-field="${esc(c)}" data-orig="${esc(m[c] ?? '')}">${esc(m[c] ?? '')}</td>`).join('')}</tr>`).join('') || `<tr><td class="muted" colspan="5">Sin metas cargadas.</td></tr>`}
      </tbody></table></div>`;
  }
  if (tab === 'catalogos') {
    body = `<div class="grid g2"><div class="card"><h3 style="margin-bottom:8px">Motivos de pérdida</h3>${MOTIVOS.map(m => `<span class="pill" style="margin:2px">${cap(m)}</span>`).join('')}<p class="tiny muted">Lista fija del brief (la API solo acepta estos valores).</p></div>
      <div class="card"><h3 style="margin-bottom:8px">Estados del embudo</h3>${(d.estados || []).length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>${(d.hojas.Estados || []).map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${d.estados.map(e => `<tr>${d.hojas.Estados.map(c => `<td contenteditable="true" data-edit="Estados" data-row="${e._row}" data-field="${esc(c)}" data-orig="${esc(e[c] ?? '')}">${esc(e[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `${ESTADOS.map(e => pillEstado(e)).join(' ')}<p class="tiny muted">${d.hojas.Estados ? 'La hoja Estados está vacía' : 'Falta la hoja Estados'}; se usa el embudo del brief. “Retenido” no tiene reglas hasta que se defina.</p>`}</div></div>`;
  }
  return `<div class="page-h"><div><h2>Ajustes</h2><p class="muted small">Solo el Jefe Comercial. Cada cambio queda en la bitácora.</p></div></div>
    <div class="seg" style="margin-bottom:12px">${tabs.map(t => `<button class="${tab === t[0] ? 'on' : ''}" data-tab="cfgTab" data-v="${t[0]}">${t[1]}</button>`).join('')}</div>${body}`;
}

function parsePegado(txt) {
  const lineas = txt.replace(/\r/g, '').split('\n').filter(x => x.trim());
  if (lineas.length < 2) return { error: 'Pega al menos la fila de encabezados y una fila de datos.' };
  const sep = lineas[0].includes('\t') ? '\t' : lineas[0].includes(';') ? ';' : ',';
  const hs = lineas[0].split(sep).map(h => h.trim());
  const rows = lineas.slice(1).map(l => { const v = l.split(sep); const o = {}; hs.forEach((h, i) => { o[h] = (v[i] || '').trim(); }); return o; });
  return { hs, rows };
}
function validarCarga() {
  const hoja = S.cargaHoja || 'Cotizaciones', d = S.data;
  S.cargaTxt = $('#carga-txt').value;
  const p = parsePegado(S.cargaTxt);
  const errores = [];
  if (p.error) errores.push(p.error);
  else {
    const cols = d.hojas[hoja];
    if (!cols) errores.push(`La hoja ${hoja} no existe en el Sheet.`);
    else {
      const extra = p.hs.filter(h => !cols.includes(h)); if (extra.length) errores.push('Columnas que no existen en ' + hoja + ': ' + extra.join(', '));
    }
    const R = CARGAS[hoja];
    R.req.filter(c => !p.hs.includes(c)).forEach(c => errores.push('Falta la columna obligatoria ' + c));
    if (R.uno.length && !R.uno.some(c => p.hs.includes(c))) errores.push('Incluye al menos una de: ' + R.uno.join(', '));
    p.rows.forEach((r, i) => {
      R.req.forEach(c => { if (p.hs.includes(c) && !r[c]) errores.push(`Fila ${i + 2}: ${c} vacío`); });
      if (r.fecha && !parseFecha(r.fecha)) errores.push(`Fila ${i + 2}: fecha no reconocida (${r.fecha})`);
      if (r.mes && !mesKey(r.mes)) errores.push(`Fila ${i + 2}: mes no reconocido (${r.mes}); usa AAAA-MM`);
      ['valor', 'precio_cotizado', 'meta_motos'].forEach(c => { if (r[c] && num(r[c]) === null) errores.push(`Fila ${i + 2}: ${c} no es número`); });
    });
  }
  // Normaliza para que el Sheet guarde números y fechas, no texto ("5.490.000", "01/10/2026").
  S.cargaRows = errores.length ? null : p.rows.map(r => {
    const o = Object.assign({}, r);
    ['valor', 'precio_cotizado', 'meta_motos'].forEach(c => { if (o[c]) o[c] = num(o[c]); });
    if (o.fecha) { const f = parseFecha(o.fecha); const b = bparts(f); o.fecha = `${ymd(f)}${b.h || b.mi ? ` ${pad(b.h)}:${pad(b.mi)}` : ''}`; }
    if (o.mes) o.mes = mesKey(o.mes);
    return o;
  });
  S.cargaPrev = errores.length ? `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div>${errores.slice(0, 15).map(esc).join('<br>')}${errores.length > 15 ? `<br>…y ${errores.length - 15} más` : ''}</div></div>` :
    `<div class="notice ok"><i class="ti ti-circle-check"></i><div>${p.rows.length} fila(s) válidas. Las que repitan la llave (${(CARGAS[hoja].req[0])}) se omiten.</div></div>
     <div class="tbl-wrap" style="margin-top:8px;max-height:260px"><table class="tbl"><thead><tr>${p.hs.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${p.rows.slice(0, 10).map(r => `<tr>${p.hs.map(h => `<td>${esc(r[h])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
     <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn btn-primary" data-act="subirCarga">Cargar ${p.rows.length} fila(s) a ${hoja}</button></div>`;
  $('#carga-prev').innerHTML = S.cargaPrev;
}

// ── Eventos ───────────────────────────────────────────────────────────────
document.addEventListener('click', async e => {
  const wl = e.target.closest('[data-wl-cerrar]');
  if (wl) return cerrarBienvenida(wl.dataset.wlIr);
  const nav = e.target.closest('[data-nav]');
  if (nav) { S.view = nav.dataset.nav; renderNav(); render(); window.scrollTo(0, 0); return; }
  if (e.target.closest('[data-close]')) {
    if (S._modalCancel) { const c = S._modalCancel; cerrarModal(); c(); } else cerrarSheet();
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) { S[tab.dataset.tab] = tab.dataset.v; render(); return; }
  const sc = e.target.closest('.score button');
  if (sc) { $$('button', sc.parentNode).forEach(b => b.classList.toggle('on', b === sc)); return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  if (MOD && a.dataset.act.startsWith('m-')) { if (a.tagName === 'A' && a.getAttribute('href') === '#') e.preventDefault(); return MOD.onClick(a.dataset.act, a, e); }
  const act = a.dataset.act, l = a.dataset.id ? S.M.byId[a.dataset.id] : null;
  if (a.tagName === 'A' && a.getAttribute('href') === '#') e.preventDefault();
  if (act === 'ver-bienvenida') return mostrarBienvenida();
  if (act === 'referido') {
    const quien = (($('#ref-por') || {}).value || '').trim();
    if (quien.length < 3) { toast('Escribe quién recomendó al cliente.', 'bad'); return; }
    a.disabled = true;
    try { await api('referido', { id_lead: a.dataset.id, referido_por: quien }); toast('Lead marcado como referido', 'ok'); S.pan = null; S.panT = 0; S.pul = null; S.ctl = null; S.ctlT = 0; await cargar(true); abrirLead(a.dataset.id); }
    catch (e) { toast(e.message, 'bad'); a.disabled = false; }
    return;
  }
  if (act === 'qr-usar' || act === 'qr-ia') return usarRespuestaRapida(a);
  if (act === 'hoy-f') { S.hoyF = S.hoyF === a.dataset.k ? '' : a.dataset.k; render(); return; }
  if (act === 'disp-activar') {
    if (S.data.user.rol !== 'jefe') return;
    a.disabled = true;
    try { await api('disponibilidad', { asesor: a.dataset.nom, disponible: true }); toast(a.dataset.nom + ' vuelve a recibir leads', 'ok'); await cargar(true); }
    catch (e) { toast(e.message, 'bad'); a.disabled = false; }
    return;
  }
  if (act === 'disp-abrir') {
    if (S.data.user.rol !== 'jefe') return;
    const nom = a.dataset.nom;
    abrirSheet(`<div class="sheet-b"><h3><i class="ti ti-user-off"></i> ${esc(nom)} no disponible</h3>
      <p class="small muted" style="margin:0">Mientras esté así no se le asignan leads nuevos (los que ya tiene siguen siendo suyos).</p>
      <label class="f" for="dp-dur">¿Por cuánto tiempo?</label>
      <select class="sel w100" id="dp-dur"><option value="2">2 horas</option><option value="4">4 horas</option><option value="cierre" selected>Hasta que cierre el punto hoy</option><option value="manana">Hasta mañana (cuando abra el punto)</option>
        <option value="24">24 horas</option><option value="72">3 días</option><option value="168">1 semana</option><option value="indefinido">Hasta que yo lo active</option></select>
      <label class="f" for="dp-mot">Motivo (opcional)</label><input class="inp w100" id="dp-mot" maxlength="120" placeholder="Ej.: cita médica, vacaciones…">
      <div class="row" style="justify-content:flex-end"><button class="btn" id="c-no">Cancelar</button><button class="btn btn-dark" id="c-si">Dejar sin leads</button></div></div>`, true);
    $('#c-no').onclick = () => cerrarModal();
    $('#c-si').onclick = async () => {
      $('#c-si').disabled = true;
      try { await api('disponibilidad', { asesor: nom, disponible: false, duracion: $('#dp-dur').value, motivo: $('#dp-mot').value.trim() }); cerrarModal(); toast(nom + ' quedó sin recibir leads', 'ok'); await cargar(true); }
      catch (e) { toast(e.message, 'bad'); $('#c-si').disabled = false; }
    };
    return;
  }
  if (act === 'cambiar-asig') {
    const l = S.M.byId[a.dataset.id]; if (!l || S.data.user.rol !== 'jefe') return;
    const eq = (S.M.asesores || []).filter(p => p.nombre), puntos = uniq(eq.map(p => p.sedeCanon).filter(Boolean)).sort();
    const sedeAct = puntos.find(s => norm(s) === norm(l.sede || '')) || puntos[0] || '';
    const optsAs = punto => opts(eq.filter(p => p.sedeCanon === punto && norm(p.nombre) !== norm(l.asesor || '')).map(p => p.nombre), '', 'Elige el nuevo asesor…');
    abrirSheet(`<div class="sheet-b"><h3><i class="ti ti-arrows-exchange"></i> Cambiar asesor / punto</h3>
      <p class="small muted" style="margin:0">${esc(l.nombre)} · hoy: <b>${esc(l.asesor || 'Sin asesor')}</b> · ${esc(l.sede || 'Sin punto')}</p>
      <label class="f" for="ca-punto">Punto de venta</label><select class="sel w100" id="ca-punto">${puntos.map(p => `<option ${p === sedeAct ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <label class="f" for="ca-as">Asesor</label><select class="sel w100" id="ca-as">${optsAs(sedeAct)}</select>
      <label class="f" for="ca-mot">Motivo (obligatorio)</label><input class="inp w100" id="ca-mot" maxlength="200" placeholder="Ej.: el cliente vive cerca de Itagüí">
      <p class="tiny muted" style="margin:6px 0 0">El asesor nuevo recibe el aviso por WhatsApp y el cambio queda auditado.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="c-no">Cancelar</button><button class="btn btn-dark" id="c-si">Cambiar</button></div></div>`, true);
    $('#ca-punto').onchange = () => { $('#ca-as').innerHTML = optsAs($('#ca-punto').value); };
    $('#c-no').onclick = () => cerrarModal();
    $('#c-si').onclick = async () => {
      const punto = $('#ca-punto').value, as = $('#ca-as').value, mot = $('#ca-mot').value.trim();
      if (!as) { toast('Elige el nuevo asesor.', 'bad'); return; }
      if (mot.length < 5) { toast('Cuenta el motivo.', 'bad'); return; }
      $('#c-si').disabled = true;
      try { await api('reasignar', { id_lead: l.id, asesor: as, punto, motivo: mot }); cerrarModal(); toast('Lead pasado a ' + as + ' · ' + punto, 'ok'); await cargar(true); }
      catch (e) { toast(e.message, 'bad'); $('#c-si').disabled = false; }
    };
    return;
  }
  if (act === 'reasignar') {
    const jefe = S.data.user.rol === 'jefe', as = ($('#reas-as') || {}).value || '', mot = (($('#reas-mot') || {}).value || '').trim();
    if (jefe && !as) { toast('Elige el nuevo asesor.', 'bad'); return; }
    if (mot.length < 5) { toast('Cuenta el motivo.', 'bad'); return; }
    a.disabled = true;
    try { await api(jefe ? 'reasignar' : 'solicitarReasignacion', { id_lead: a.dataset.id, asesor: as, motivo: mot }); toast(jefe ? 'Lead reasignado y auditado' : 'Solicitud enviada al Jefe', 'ok'); if (jefe) { await cargar(true); cerrarSheet(); } else a.disabled = false; }
    catch (e) { toast(e.message, 'bad'); a.disabled = false; }
    return;
  }
  if (act === 'panel-f') { S.panF = S.panF === a.dataset.k ? '' : a.dataset.k; render(); return; }
  if (act === 'pan-filtro') { const v = a.dataset.v; if (a.dataset.k === 'sede') S.panSede = v; else S.panDias = Number(v); S.pan = null; S.panT = 0; render(); return; }
  if (act === 'pulso-toggle') { S.pulAbierto = !S.pulAbierto; const c = $('#hoy-pulso'), b = $('#pulso-btn'); if (c) c.hidden = !S.pulAbierto; if (b) b.querySelector('i').className = 'ti ' + (S.pulAbierto ? 'ti-chevron-up' : 'ti-chevron-down'); return; }
  if (act === 'pulso-f') { S.pulF = S.pulF === a.dataset.k ? '' : a.dataset.k; const c = $('#hoy-pulso'); if (c) c.innerHTML = pulsoHtml(); return; }
  if (act === 'eq-sel') { S.eqSel = a.dataset.id || ''; render(); return; }
  if (act === 'entrega-rapida') {
    a.disabled = true;
    try { await api('entrega', { id_lead: a.dataset.id }); toast('Entrega registrada. Ahora agenda la revisión técnica.', 'ok'); S.pan = null; S.panT = 0; render(); cargar(true); }
    catch (e) { toast(e.message, 'bad'); a.disabled = false; }
    return;
  }
  if (act === 'val-venta') {
    const nro = a.dataset.id, sel = document.getElementById('val-as-' + nro), asesor = sel ? sel.value : '';
    if (!asesor) { toast('Elige el asesor que hizo la venta.', 'bad'); return; }
    a.disabled = true;
    try { await api('validarVenta', { nro_factura: nro, asesor }); toast('Asesor validado', 'ok'); S.pil = null; S.pilT = 0; S.pul = null; S.pan = null; S.panT = 0; const c = $('#ctl-cuerpo'); if (c) c.innerHTML = cuerpoControl(); else render(); cargar(true); }
    catch (e) { toast(e.message, 'bad'); a.disabled = false; }
    return;
  }
  if (act === 'rev-asignar' || act === 'rev-descartar') {
    const id = a.dataset.id, sel = document.getElementById('rev-as-' + id), asesor = sel ? sel.value : '';
    if (act === 'rev-asignar' && !asesor) { toast('Elige a qué asesor asignarla.', 'bad'); return; }
    a.disabled = true;
    try { await api('revisarOportunidad', { id_cotizacion: id, accion: act === 'rev-asignar' ? 'asignar' : 'descartar', asesor }); toast(act === 'rev-asignar' ? 'Asignada: ya cuenta en la gestión' : 'Descartada (no es de tu equipo)', 'ok'); S.pil = null; S.pilT = 0; S.ctl = null; S.ctlT = 0; const c = $('#ctl-cuerpo'); if (c) c.innerHTML = cuerpoControl(); cargar(true); }
    catch (e) { toast(e.message, 'bad'); a.disabled = false; }
    return;
  }
  if (act === 'pv-hecho') { a.disabled = true; try { await api('posventa', { id_lead: a.dataset.id, tipo: a.dataset.tipo }); toast('Posventa registrada', 'ok'); S.ctl = null; S.ctlT = 0; render(); } catch (e) { toast(e.message, 'bad'); a.disabled = false; } return; }
  if (act === 'ctl-recargar') { S.ctl = null; S.ctlT = 0; return render(); }
  if (act === 'prox-abrir') { const lp = S.M.byId[a.dataset.id]; if (lp) return programarProxima(lp); toast('Ese lead no está en tu lista actual.', 'bad'); return; }
  if (act === 'rec-abrir') return registrarRecuperacion(a.dataset.id);
  if (act === 'emoji-abrir') { const p = $('#emoji-panel'); if (p) { p.hidden = !p.hidden; if (!p.hidden) pintarEmojis(); } return; }
  if (act === 'emoji-cat') return pintarEmojis(a.dataset.c);
  if (act === 'emoji-add') return insertarEmoji(a.dataset.e);
  if (['etapa', 'cita-estado', 'cita-nueva', 'cita-revision', 'entrega-moto'].includes(act)) return accionAvance(act, a);
  if (act === 'ind-recargar') { S.indT = 0; S.ind = null; cargarIndicadores(); return render(); }
  if (act === 'chat-abrir') return abrirChatBandeja(a.dataset.id);
  if (act === 'chat-zoom') return zoomChat(a.dataset.url);
  if (act === 'ir-chat') { cerrarSheet(); S.chatSel = a.dataset.id; S.view = 'chats'; renderNav(); return render(); }
  if (act === 'chat-volver') { S.chatSel = null; S.leadAbierto = null; return render(); }
  if (act === 'chat-enviar') return enviarChat(a.dataset.id, a);
  if (act === 'chat-bot') return cambiarAtencionChat(a.dataset.id, 'bot');
  if (act === 'chat-tomar') return cambiarAtencionChat(a.dataset.id, 'asesor');
  if (act === 'copiar-acceso') { try { await navigator.clipboard.writeText(a.dataset.url); toast('Enlace copiado', 'ok'); } catch (err) { toast(a.dataset.url); } return; }
  if (act === 'abrir' && l) return abrirLead(l.id);
  if (act === 'contactado' && l) { if (!puedeEditar(l)) return; if (!l.g) { toast('n8n aún no creó la fila de gestión de este lead.', 'bad'); return; } await registrarContacto(l, false); return refrescar(); }
  if (act === 'justificar-contacto' && l) { await registrarContacto(l, true); return refrescar(); }
  if (act === 'cotizado' && l) return moverA(l, 'Cotizado');
  if (act === 'perdido' && l) return moverA(l, 'Perdido');
  if (act === 'detenido' && l) return moverA(l, 'Retenido');
  if (act === 'facturado' && l) return moverA(l, 'Facturado');
  if (act === 'temp' && l) { const v = l.temp === a.dataset.v ? '' : a.dataset.v; await setCampo(l, 'Leads', 'etiqueta_asesor', v); return refrescar(); }
  if (act === 'respuesta' && l) { if (await setCampo(l, 'Gestion_Asesor', 'respuesta_cliente', $('#resp-cli').value.trim())) toast('Respuesta guardada', 'ok'); return refrescar(); }
  if (act === 'reasignar' && l) {
    const v = $('#reasignar').value;
    if (!v || norm(v) === norm(l.asesor)) return;
    if (!(await confirmar('Reasignar lead', `¿Pasar <b>${esc(l.nombre)}</b> de ${esc(l.asesor || 'sin asesor')} a <b>${esc(v)}</b>?`, 'Reasignar'))) return abrirLead(l.id);
    if (await setCampo(l, 'Leads', 'nombre_asesor', v)) { if (l.g) await setCampo(l, 'Gestion_Asesor', 'nombre_asesor', v); toast('Lead reasignado a ' + v, 'ok'); }
    S.leadAbierto = l.id; return refrescar();
  }
  if (act === 'nuevoSeg') return formSeguimiento(a.dataset.tipo, a.dataset.ev);
  if (act === 'addComp') return agregarCompromiso();
  if (act === 'guardarSeg') return guardarSeguimiento(a);
  if (act === 'verSeg') return verSeguimiento(a.dataset.id);
  if (act === 'imprimir') { document.body.classList.add('printing-sheet'); window.print(); document.body.classList.remove('printing-sheet'); return; }
  if (act === 'guardarCfg') {
    const valores = {}; $$('[data-cfg]').forEach(i => { if (i.value.trim() !== String(S.M.cfg.raw[i.dataset.cfg] ?? '')) valores[i.dataset.cfg] = i.value.trim(); });
    const malos = Object.entries(valores).filter(([k, v]) => k !== 'escalamiento_destinatario' && v !== '' && (num(v) === null || num(v) < 0));
    if (malos.length) return toast('Valores no numéricos: ' + malos.map(m => m[0]).join(', '), 'bad');
    if (!Object.keys(valores).length) return toast('No hay cambios.');
    a.disabled = true;
    try { await api('config', { valores }); toast('Umbrales guardados', 'ok'); await cargar(true); } catch (err) { toast(err.message, 'bad'); a.disabled = false; }
    return;
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (MOD && t.dataset.mch !== undefined) return MOD.onChange(t, e);
  if (t.id === 'pil-dias') { S.pilDias = Number(t.value); S.pil = null; S.pilT = 0; const c = $('#ctl-cuerpo'); if (c) c.innerHTML = cuerpoControl(); return; }
  if (t.id === 'ctl-dias') { S.ctlDias = Number(t.value); S.ctl = null; S.ctlT = 0; render(); return; }
  if (t.dataset.f !== undefined) { S.f[t.dataset.f] = t.value; if (t.dataset.f === 'punto') S.f.asesor = ''; render(); return; }
  if (t.dataset.sf !== undefined) { S.segFiltro[t.dataset.sf] = t.value; render(); return; }
  if (t.dataset.ch === 'zonDias') { S.zonDias = Number(t.value); S.zon = null; S.zonT = 0; render(); return; }
  if (t.dataset.ch) { S[t.dataset.ch] = t.value; render(); return; }
  if (t.dataset.mover) { const l = S.M.byId[t.dataset.mover]; if (l && t.value) moverA(l, t.value); t.value = ''; return; }
  if (t.dataset.actCh === 'resultado') {
    const l = S.M.byId[t.dataset.id]; const v = t.value;
    const destino = { ganado: 'Facturado', perdido: 'Perdido', retenido: 'Retenido' }[v];
    if (destino) moverA(l, destino).then(() => S.leadAbierto && abrirLead(l.id));
    else toast('Para devolver un lead a “En proceso”, pídelo al Jefe Comercial.', 'bad');
  }
});
document.addEventListener('focusout', async e => {
  const td = e.target.closest && e.target.closest('[data-edit]');
  if (!td) return;
  const nuevo = td.textContent.trim(), orig = td.dataset.orig;
  if (nuevo === orig) return;
  try {
    const r = await api('adminUpdate', { sheet: td.dataset.edit, row: Number(td.dataset.row), field: td.dataset.field, value: nuevo, expected: orig });
    if (r.conflict) { toast(r.error, 'bad'); await cargar(true); return; }
    td.dataset.orig = nuevo; toast(`${td.dataset.edit}: ${td.dataset.field} guardado`, 'ok');
    await cargar(true);
  } catch (err) { toast(err.message, 'bad'); td.textContent = orig; }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#welcome') && !$('#welcome').hidden) return cerrarBienvenida();
  if (e.key === 'Escape' && !$('#sheet').hidden) {
    if (S._modalCancel) { const c = S._modalCancel; cerrarModal(); c(); } else cerrarSheet();
  }
  if (e.key === 'Enter' && e.target.dataset && e.target.dataset.edit) { e.preventDefault(); e.target.blur(); }
});
$('#btn-refresh').onclick = () => cargar();
$('#btn-logout').onclick = () => { if (DEMO) location.href = location.pathname; else salir(); };
$('#demo-role').onchange = e => { S.demoRole = e.target.value; S.hoyAsesor = ''; S.f.asesor = ''; S.f.punto = ''; cargar(); };

// ── Módulos de la etapa 2 (modulos.js) ────────────────────────────────────
// Se les pasan las utilidades de la app para que usen el mismo estado, API y estilo.
const H = {
  S, api, $, $$, esc, norm, digits, tel10, si, pad, num, pct, fmtPct, money, cap, uniq, sedeCanon, cedulaDe,
  parseFecha, fmtFecha, ymd, ym, bparts, bog, fmtMes, mesKey, mesesRecientes, horasHabiles, fmtHoras,
  toast, empty, kpi, bars, contar, opts, abrirSheet, cerrarSheet, confirmar, render, renderNav, cargar, parsePegado,
  vAcompanamientos: vSeguimientos
};
const MOD = window.AKT_MODULOS ? window.AKT_MODULOS(H) : null;

// ── Arranque ──────────────────────────────────────────────────────────────
window.AKT_TEST = { horasHabiles, festivos, parseFecha, bog, mesKey };
if (DEMO) arrancar();
else {
  $('#login-form').addEventListener('submit', entrar);
  $('#login-eye').onclick = () => { const p = $('#login-pass'); p.type = p.type === 'password' ? 'text' : 'password'; };
  const t = read('akt_ses');
  if (t && tokenVigente(t)) { S.token = t; arrancar(); } else mostrarLogin();
}
})();

