/* CRM Leads Motos — app.js
 * Toda la interfaz. Los datos vienen de la API (Apps Script) en un solo lote
 * ("bootstrap") y se escriben celda por celda con control de concurrencia.
 */
(function () {
'use strict';

const APP_VERSION = 'akt-crm-1.1.0';
const CFG = Object.assign({ API_URL: '', REFRESH_MS: 90000 }, window.AKT_CONFIG || {});
const DEMO = /[?&]demo=1\b/.test(location.search);

const ESTADOS = ['Nuevo', 'Contactado', 'Cotizado', 'Facturado', 'Perdido', 'Retenido'];
const MOTIVOS = ['precio', 'financiación negada', 'compró en otro lado', 'no contesta', 'atención', 'aún no decide', 'otro'];
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
  if (DEMO) { $('#demo-link').hidden = true; return; }
  if (!CFG.API_URL) {
    $('#login-form').hidden = true;
    box.hidden = false;
    box.textContent = 'Falta configurar API_URL en config.js (la URL /exec del Apps Script, ver backend/README.md). Mientras tanto puedes revisar el modo demo.';
    return;
  }
  $('#login-form').hidden = false;
  setTimeout(() => $('#login-ced').focus(), 50);
}

async function entrar(ev) {
  ev.preventDefault();
  const btn = $('#login-btn'), box = $('#login-msg');
  const cedula = $('#login-ced').value.replace(/\D/g, ''), password = $('#login-pass').value;
  if (!cedula || !password) { box.hidden = false; box.textContent = 'Escribe tu número de cédula y la contraseña.'; return; }
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2 spin"></i> Entrando…'; box.hidden = true;
  try {
    const r = await api('login', { cedula, password });
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
    else if (/^(ganad|factur|vendid)/.test(res)) estado = 'Facturado';
    else if (res.startsWith('perd')) estado = 'Perdido';
    else if (res.startsWith('reten')) estado = 'Retenido';
    else if (cotizado) estado = 'Cotizado';
    else if (contactado) estado = 'Contactado';

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
      id, raw: l, g, estado, incons, cot, fac, alertas, tel, asign, contactadoEn, hAsign, hPrimera, ultimaAct,
      contactado, cotizado, resultado: res, motivo: (g && g.motivo_perdida) || '',
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

// ── Navegación ────────────────────────────────────────────────────────────
function vistasDeRol() {
  const r = S.data.user.rol;
  const v = [
    { id: 'hoy', icon: 'ti-checklist', label: 'Hoy' },
    { id: 'chats', icon: 'ti-messages', label: 'Chats' },
    { id: 'embudo', icon: 'ti-layout-kanban', label: 'Embudo' },
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
  const base = { hoy: vHoy, chats: vChats, embudo: vEmbudo, metas: vMetas, indicadores: vIndicadores, analista: vAnalista, comisiones: vComisiones, conciliacion: vConciliacion, accesos: vAccesos, config: vConfig };
  const fn = (MOD && MOD.views[S.view]) || base[S.view];
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
function pillEstado(e) {
  const c = { Nuevo: 'pill-info', Contactado: '', Cotizado: 'pill-warn', Facturado: 'pill-ok', Perdido: 'pill-bad', Retenido: 'pill-dark' }[e] || '';
  return `<span class="pill ${c}">${esc(e)}</span>`;
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
  if (ed && !['Facturado', 'Perdido'].includes(l.estado)) acciones.push(`<button class="btn btn-sm" data-act="perdido" data-id="${esc(l.id)}"><i class="ti ti-x"></i> Perdido</button>`);
  // El chat se atiende dentro de la app con el número del negocio (no desde el WhatsApp personal del asesor)
  acciones.push(`<button class="btn btn-sm btn-wa" data-act="ir-chat" data-id="${esc(l.id)}"><i class="ti ti-messages"></i> Chat</button>`);
  return `<article class="lead ${s}">
    <div class="lead-top"><div class="lead-id"><div class="av av-${norm(l.tempIA || l.temp)}">${esc(iniciales(l.nombre))}</div><div><div class="lead-name" data-act="abrir" data-id="${esc(l.id)}">${esc(l.nombre)}</div>
      <div class="lead-sub">${esc(l.asesor || 'Sin asesor')} · ${esc(l.sede || 'Sin punto')}</div></div></div>
      <div class="row" style="flex-direction:column;align-items:flex-end;gap:4px">${pillEstado(l.estado)}${timer}</div></div>
    <div class="lead-facts">${contactoTxt(l)}
      ${r.modelo_interes ? `<span><i class="ti ti-motorbike"></i>${esc(r.modelo_interes)}</span>` : ''}
      ${r.zona ? `<span><i class="ti ti-map-pin"></i>${esc(r.zona)}</span>` : ''}
      ${r.intencion_compra ? `<span><i class="ti ti-target-arrow"></i>${esc(r.intencion_compra)}</span>` : ''}
      ${r.forma_pago ? `<span><i class="ti ti-credit-card"></i>${esc(r.forma_pago)}</span>` : ''}
      ${l.cita ? `<span class="${l.citaHoy ? '' : 'muted'}"><i class="ti ti-calendar-event"></i>${l.citaHoy ? '<b>Cita hoy</b> ' + esc(horaTxt(r.cita_hora) || '') : fmtFecha(l.cita, !!r.cita_hora)}</span>` : ''}
    </div>
    ${l.incons.length ? `<div class="notice bad small" style="padding:6px 10px"><i class="ti ti-alert-triangle"></i><div>${l.incons.map(esc).join('<br>')}</div></div>` : ''}
    <div class="row between wrap"><div class="tags">${l.tempIA ? pillTemp(l.tempIA, 'IA: ') : '<span class="pill">IA: sin etiqueta</span>'}
      ${ed ? TEMPS.map(t => `<button class="tag-btn t-${norm(t)} ${l.temp === t ? 'on' : ''}" data-act="temp" data-v="${t}" data-id="${esc(l.id)}">${t}</button>`).join('') : pillTemp(l.temp, 'Asesor: ')}</div></div>
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
function vHoy() {
  const u = S.data.user, ls = leadsAlcance(), M = S.M;
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
  if (sinGestion) avisos.push(`${sinGestion} lead(s) aún no tienen fila en Gestion_Asesor (la crea n8n). Hasta entonces no se pueden marcar.`);

  return `<div class="page-h"><div><h2>Hoy</h2><p class="muted small">${cap(fmtFecha(new Date(), false))} · ${abiertos.length} leads abiertos · plazos en horas hábiles</p></div>
    ${u.rol !== 'asesor' ? `<select class="sel" data-ch="hoyAsesor">${opts(M.asesores.filter(p => u.rol === 'jefe' || p.sedeCanon === u.sede).map(p => p.nombre), S.hoyAsesor, u.rol === 'jefe' ? 'Todos los asesores' : 'Todo mi punto')}</select>` : ''}</div>
    ${avisos.map(a => `<div class="notice" style="margin-bottom:8px"><i class="ti ti-info-circle"></i><div>${esc(a)}</div></div>`).join('')}
    <div class="grid g-kpi">
      ${kpi('SLA vencido', vencidos, `≥ ${M.cfg.sla_vencida_h} h hábiles sin contacto`, vencidos ? 'bad' : 'ok')}
      ${kpi('Citas hoy', grupos[1].items.length + abiertos.filter(l => l.citaHoy && l.sla === 'bad').length, '')}
      ${kpi('Nuevos', abiertos.filter(l => l.estado === 'Nuevo').length, 'sin contactar')}
      ${kpi('Alertas abiertas', alertas.length, S.data.hojas.Alertas_Log ? 'de Alertas_Log (n8n)' : 'falta la hoja Alertas_Log', alertas.length ? 'warn' : '')}
    </div>
    ${grupos.filter(g => g.items.length).map(g => `<div class="section-title"><i class="ti ${g.icon}"></i>${g.t}<span class="count">${g.items.length}</span></div>
      <div class="list">${g.items.map(leadCard).join('')}</div>`).join('') || `<div style="margin-top:16px">${empty('ti-mood-check', 'No tienes leads pendientes. ¡Todo al día!')}</div>`}`;
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
      <div class="card"><div class="row wrap">${contactoTxt(l)}<span class="grow"></span>${S.view !== 'chats' ? `<button class="btn btn-sm btn-wa" data-act="ir-chat" data-id="${esc(l.id)}"><i class="ti ti-messages"></i> Chat</button>` : ''}</div>
        ${l.cita ? `<p class="small" style="margin:8px 0 0"><i class="ti ti-calendar-event"></i> Cita: <b>${fmtFecha(l.cita, !!r.cita_hora)}</b></p>` : ''}</div>

      ${ed ? `<div class="card"><div class="card-h"><h3>Gestión</h3>${l.g ? `<span class="tiny muted">Últ. act. ${fmtFecha(l.ultimaAct)}</span>` : ''}</div>
        ${!l.g ? `<div class="notice"><i class="ti ti-info-circle"></i><div>n8n aún no creó la fila de este lead en Gestion_Asesor. Puedes cambiar la etiqueta, pero no la gestión.</div></div>` : `
        <div class="grid g2">
          <div><label class="f">Contactado</label><div class="row"><span class="pill ${l.contactado ? 'pill-ok' : ''}">${l.contactado ? 'Sí' + (l.contactadoEn ? ' · ' + fmtFecha(l.contactadoEn) : '') : 'No'}</span>${!l.contactado ? `<button class="btn btn-sm btn-dark" data-act="contactado" data-id="${esc(l.id)}">Marcar contactado</button>` : ''}</div></div>
          <div><label class="f">Cotizado</label><div class="row"><span class="pill ${l.cotizado ? 'pill-warn' : ''}">${l.cotizado ? 'Sí' : 'No'}</span>${!l.cotizado && !['Facturado', 'Perdido'].includes(l.estado) ? `<button class="btn btn-sm" data-act="cotizado" data-id="${esc(l.id)}">Marcar cotizado</button>` : ''}</div></div>
          <div><label class="f">Resultado</label><select class="sel w100" data-act-ch="resultado" data-id="${esc(l.id)}">${opts([{ v: '', t: 'En proceso' }, { v: 'ganado', t: 'Ganado (facturado)' }, { v: 'perdido', t: 'Perdido' }, { v: 'retenido', t: 'Retenido' }], norm(g.resultado) === 'perdido' ? 'perdido' : norm(g.resultado).startsWith('gan') ? 'ganado' : norm(g.resultado).startsWith('ret') ? 'retenido' : '')}</select></div>
          <div><label class="f">Motivo de pérdida</label><div class="row"><span class="small">${esc(g.motivo_perdida || '—')}</span></div></div>
        </div>
        <div style="margin-top:10px"><label class="f">Respuesta del cliente</label><textarea class="inp" id="resp-cli" maxlength="500" placeholder="¿Qué respondió el cliente?">${esc(g.respuesta_cliente || '')}</textarea>
          <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn btn-sm" data-act="respuesta" data-id="${esc(l.id)}">Guardar respuesta</button></div></div>`}
        <div style="margin-top:10px"><label class="f">Temperatura (decisión del asesor · la IA propone: ${esc(l.tempIA || 'sin etiqueta')})</label>
          <div class="tags">${TEMPS.map(t => `<button class="tag-btn t-${norm(t)} ${l.temp === t ? 'on' : ''}" data-act="temp" data-v="${t}" data-id="${esc(l.id)}">${t}</button>`).join('')}</div></div>
        ${u.rol !== 'asesor' ? `<div style="margin-top:12px"><label class="f">Reasignar asesor</label><div class="row"><select class="sel grow" id="reasignar">${opts(asesores.map(p => p.nombre), l.asesor, '— Elegir —')}</select><button class="btn btn-sm" data-act="reasignar" data-id="${esc(l.id)}">Reasignar</button></div></div>` : ''}
      </div>` : ''}

      ${cardAvance(l, ed)}

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
    ${citas.length ? citas.map(c => `<div class="row wrap" style="gap:6px;margin-bottom:4px"><span class="small"><i class="ti ti-calendar-event"></i> <b>${esc(String(c.fecha).slice(0, 10))} ${esc(String(c.hora).slice(0, 5))}</b> · ${esc(l.sede || '')}</span><span class="pill ${clsCita[c.estado] || ''}">${esc(c.estado)}</span>
      ${ed && c.estado === 'agendada' ? ['asistió', 'no asistió', 'cancelada'].map(s => `<button class="btn btn-sm" data-act="cita-estado" data-id="${esc(l.id)}" data-cita="${esc(c.id_cita)}" data-v="${s}">${s === 'asistió' ? 'Asistió' : s === 'no asistió' ? 'No asistió' : 'Cancelar'}</button>`).join('') : ''}</div>`).join('') : '<p class="small muted" style="margin:0">Sin citas registradas.</p>'}
    ${ed ? `<div class="row wrap" style="gap:6px;margin-top:8px"><input class="inp" type="date" id="cita-f" min="${hoy}" style="max-width:160px"><input class="inp" type="time" id="cita-h" style="max-width:120px"><button class="btn btn-sm btn-dark" data-act="cita-nueva" data-id="${esc(l.id)}"><i class="ti ti-calendar-plus"></i> Agendar cita</button></div>
      <p class="tiny muted" style="margin:6px 0 0">Al agendar, el cliente recibe recordatorio 24 h y 2 h antes, y tú 2 h antes.</p>` : ''}
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
    await recargarLead();
  } catch (e) { toast(e.message, 'bad'); a.disabled = false; }
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
    pintarBandeja();
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

// ── Chat del asesor (Fase 1): responde desde la app; el bot se pausa mientras hay asesor asignado ──
let chatTimer = null, chatSig = '';
function pintarChat(id, r2, forzarScroll) {
  if (S.leadAbierto !== id || !$('#chat')) return;
  const ms = r2.mensajes || [], at = r2.atencion || {};
  const sig = ms.length + '|' + (ms.length ? ms[ms.length - 1].fecha_hora : '') + '|' + at.estado;
  const c = $('#chat');
  const abajo = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
  if (sig !== chatSig) {
    chatSig = sig;
    c.innerHTML = ms.length ? ms.map(m => {
      const rm = norm(m.remitente);
      const cls = rm.startsWith('asesor') ? 'ase' : /bot|ia|asistente|agente/.test(rm) ? 'bot' : 'cli';
      const quien = cls === 'ase' ? 'Asesor' : cls === 'bot' ? 'Bot' : 'Cliente';
      return `<div class="msg ${cls}">${esc(m.mensaje)}<small>${quien} · ${fmtFecha(parseFecha(m.fecha_hora))}</small></div>`;
    }).join('') : '<p class="small muted">Sin mensajes en Historial_Chats para este contacto.</p>';
    if (forzarScroll || abajo) c.scrollTop = c.scrollHeight;
  }
  const pausado = at.estado !== 'bot' && at.asesor;
  const vence = at.vence_reasignacion ? new Date(at.vence_reasignacion) : null;
  $('#chat-estado').innerHTML = (pausado
    ? `<span class="pill pill-info"><i class="ti ti-player-pause"></i> Bot en pausa · atiende ${esc(at.asesor)}</span>${vence ? `<span class="pill ${vence - Date.now() < 3 * 3600e3 ? 'pill-warn' : ''}" title="A las 20 h sin gestión se le recuerda al asesor y se escribe al cliente; a las 23 h se reasigna a otro asesor del punto">Gestiona antes de: ${fmtFecha(vence)}</span>` : ''}`
    : `<span class="pill pill-ok"><i class="ti ti-robot"></i> Bot activo</span>`)
    + `<span class="pill ${at.ventana_abierta ? 'pill-ok' : 'pill-bad'}" title="WhatsApp permite texto libre solo 24 h después del último mensaje del cliente">${at.ventana_abierta ? 'Ventana WhatsApp abierta hasta ' + fmtFecha(new Date(at.ventana_cierra)) : 'Ventana de 24 h cerrada'}</span>`
    + (at.gestionado ? '<span class="pill pill-ok"><i class="ti ti-check"></i> Gestionado por el asesor</span>' : '')
    // El asesor no devuelve chats al bot: una vez asignado debe garantizar la gestión (solo Jefe/Admin pueden devolverlo).
    + (at.puede_escribir ? (pausado ? (S.data.user.rol !== 'asesor' && norm(at.asesor) !== norm(S.data.user.nombre) ? `<button class="btn btn-sm" data-act="chat-bot" data-id="${esc(id)}"><i class="ti ti-robot"></i> Devolver al bot</button>` : '')
      : `<button class="btn btn-sm btn-dark" data-act="chat-tomar" data-id="${esc(id)}"><i class="ti ti-hand-stop"></i> Tomar chat (pausar bot)</button>`) : '');
  const box = $('#chat-box');
  if (!box.dataset.listo) {
    box.dataset.listo = '1';
    box.innerHTML = at.puede_escribir ? `${chipsRespuestas(id, at)}<div class="chat-box"><textarea class="inp" id="chat-txt" maxlength="3000" placeholder="Escribe tu respuesta al cliente…"></textarea>
      <button class="btn btn-primary" data-act="chat-enviar" data-id="${esc(id)}"><i class="ti ti-send"></i> Enviar</button></div><div class="chat-aviso" id="chat-aviso"></div>`
      : '<p class="chat-aviso">Solo el asesor asignado (o su jefe/administrador) puede escribirle a este cliente.</p>';
  }
  const aviso = $('#chat-aviso'), btn = box.querySelector('[data-act="chat-enviar"]');
  if (aviso) {
    const motivo = !at.envio_configurado ? 'El envío por WhatsApp no está configurado en el servidor.' : !at.ventana_abierta ? 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp exige una plantilla aprobada para retomarlo.' : '';
    aviso.textContent = motivo || 'El mensaje sale desde el número del negocio y queda registrado. Tu primer mensaje marca el lead como contactado.';
    if (btn) btn.disabled = !!motivo;
  }
}
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
    .finally(() => { if (S.leadAbierto === id && !DEMO) chatTimer = setTimeout(() => cargarChat(id), 15000); });
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
    etapaLocal(l, resultado === 'ganado' ? 'Facturado' : resultado === 'perdido' ? 'Perdido' : 'Retenido');
    return true;
  } catch (e) { toast(e.message, 'bad'); return false; }
}
function f2Key(l) { return String(l.raw.id_lead || l.id); }
function etapaLocal(l, etapa) {
  const F = S.data.fase2 = S.data.fase2 || { citas: [], etapas: [], perfiles: [], encuestas: [] };
  F.etapas.push({ id_lead: f2Key(l), etapa, fecha: new Date().toISOString(), por: S.data.user.nombre });
}
async function recargarLead() { await cargar(true); if (S.leadAbierto) abrirLead(S.leadAbierto); }

async function moverA(l, destino) {
  if (destino === l.estado) return;
  if (!puedeEditar(l)) { toast('Solo puedes mover tus propios leads.', 'bad'); return; }
  const orden = ESTADOS.indexOf.bind(ESTADOS);
  if (destino === 'Nuevo' || (orden(destino) < orden(l.estado) && ['Contactado', 'Cotizado'].includes(destino)) || ['Facturado', 'Perdido'].includes(l.estado) && destino !== 'Retenido') {
    if (!(l.estado === 'Retenido' && ['Cotizado', 'Facturado', 'Perdido'].includes(destino))) {
      toast('No se puede devolver un lead a una etapa anterior desde la app. Pídelo al Jefe Comercial.', 'bad'); return;
    }
  }
  if (!l.g) { toast('n8n aún no creó la fila de gestión de este lead.', 'bad'); return; }
  const leadTxt = `<b>${esc(l.nombre)}</b>`;
  if (destino === 'Contactado') {
    await setCampo(l, 'Gestion_Asesor', 'contactado', 'Sí');
  } else if (destino === 'Cotizado') {
    if (!l.cot.length && !(await confirmar('Sin cotización en el CRM', `No hay una cotización cargada para ${leadTxt}. Si continúas, el lead queda marcado como <b>Inconsistencia</b> y el Jefe Comercial lo verá en Conciliación.`, 'Marcar igual'))) return;
    if (!l.contactado && !(await setCampo(l, 'Gestion_Asesor', 'contactado', 'Sí'))) return refrescar();
    await setCampo(l, 'Gestion_Asesor', 'cotizado', 'Sí');
  } else if (destino === 'Facturado') {
    if (!l.fac.length && !(await confirmar('Sin factura', `No hay factura vinculada a ${leadTxt}. Quedará como <b>pendiente de facturar</b> hasta que el Jefe cargue la factura.`, 'Marcar ganado'))) return;
    if (!(await cerrarLead(l, 'ganado'))) return refrescar();
  } else if (destino === 'Perdido') {
    const m = await pedirMotivo(l);
    if (!m) return;
    if (!(await cerrarLead(l, 'perdido', m))) return refrescar();
  } else if (destino === 'Retenido') {
    if (!(await confirmar('Marcar como retenido', `La definición de "Retenido" está pendiente del Jefe Comercial. ¿Marcar ${leadTxt} como retenido?`, 'Marcar retenido'))) return;
    if (!(await cerrarLead(l, 'retenido'))) return refrescar();
  }
  toast(`${l.nombre} → ${destino}`, 'ok');
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
  return `<div class="page-h"><div><h2>Embudo</h2><p class="muted small">Arrastra una tarjeta para cambiar su estado (en celular usa “Mover a”). Cotizado y Facturado exigen evidencia.</p></div></div>
    ${filtrosHTML()}
    <div class="kanban">${ESTADOS.map(e => {
      const items = ls.filter(l => l.estado === e);
      return `<div class="col" data-col="${e}"><div class="col-h">${e} <small>${items.length}</small></div>
        ${items.slice(0, 150).map(l => `<div class="kcard ${l.incons.length ? 'incons' : ''}" draggable="${puedeEditar(l)}" data-drag="${esc(l.id)}">
          <b data-act="abrir" data-id="${esc(l.id)}" style="cursor:pointer">${esc(l.nombre)}</b>
          <div class="muted">${esc(l.raw.modelo_interes || 'Sin modelo')} · ${esc(l.asesor || 'Sin asesor')}</div>
          <div class="row wrap" style="margin-top:4px;gap:4px">${pillTemp(l.temp || l.tempIA)}${l.incons.length ? '<span class="pill pill-bad">Inconsistencia</span>' : ''}${l.sla === 'bad' ? '<span class="pill pill-bad">SLA vencido</span>' : ''}</div>
          ${puedeEditar(l) && !['Facturado', 'Perdido'].includes(e) ? `<select class="sel" data-mover="${esc(l.id)}"><option value="">Mover a…</option>${ESTADOS.filter(x => x !== e && x !== 'Nuevo').map(x => `<option>${x}</option>`).join('')}</select>` : ''}
        </div>`).join('')}
        ${items.length > 150 ? `<div class="tiny muted">+${items.length - 150} más (usa filtros)</div>` : ''}
        ${!items.length ? '<div class="tiny muted" style="text-align:center;padding:12px">Vacío</div>' : ''}</div>`;
    }).join('')}</div>`;
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
  const u = S.data.user, mes = mesesRecientes(1)[0], G = avanceGlobal(mes), d = diasDelMes(mes);
  const hora = bparts(new Date()).h, saludo = hora < 12 ? 'Buenos días' : hora < 18 ? 'Buenas tardes' : 'Buenas noches';
  const principal = G.propio || G.total || G.puntos[0];
  principal.mes = mes;
  const kp = (n, t, c) => `<div class="wl-kpi ${c || ''}"><b data-n="${n}">0</b><span>${t}</span></div>`;
  const secundarios = G.propio ? [] : G.puntos.length > 1 ? G.puntos : [];
  const html = `<div class="wl-backdrop" data-wl-cerrar></div><div class="wl-card" role="dialog" aria-modal="true" aria-label="Resumen del mes">
    <button class="icon-btn wl-x" data-wl-cerrar title="Cerrar"><i class="ti ti-x"></i></button>
    <div class="wl-top"><div class="wl-saludo">${saludo}, ${esc(String(u.nombre).split(' ')[0])} 👋</div><div class="wl-mes">${esc(fmtMes(mes))} · día ${d.transc} de ${d.total}</div></div>
    <div class="wl-kpis">${kp(principal.leads, 'Leads del mes')}${kp(principal.contactados, 'Contactados')}${kp(principal.cotizados, 'Cotizados')}${kp(principal.motos, 'Motos vendidas', 'wl-venta')}</div>
    <div class="wl-meta"><div class="wl-meta-t"><i class="ti ti-target"></i> ${G.propio ? 'Tu meta del mes' : G.total && G.puntos.length > 1 ? 'Meta del mes · los dos puntos' : 'Meta del mes · ' + esc(principal.nombre)}</div>
      ${barraMeta(principal, true)}<p class="wl-ritmo">${esc(textoRitmo(principal))}</p></div>
    ${secundarios.length ? `<div class="wl-puntos">${secundarios.map(p => { p.mes = mes; return `<div class="wl-punto"><b>${esc(p.nombre)}</b>${barraMeta(p)}<span class="tiny muted">${p.leads} leads · ${p.contactados} contactados</span></div>`; }).join('')}</div>` : ''}
    <div class="wl-acciones"><button class="btn" data-wl-cerrar data-wl-ir="metas"><i class="ti ti-chart-bar"></i> Ver detalle de metas</button><button class="btn btn-primary wl-entrar" data-wl-cerrar><i class="ti ti-arrow-right"></i> Entrar a la app</button></div></div>`;
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
    mis
  };
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
    <div class="notice" style="margin-bottom:10px"><i class="ti ti-info-circle"></i><div><b>La comisión queda en blanco</b> hasta que el Jefe Comercial entregue la regla numérica (valor o porcentaje, escalas por meta, bonos por modelo, ventas fuera del bot y fecha de inicio).<br>
      <span class="small">Referencias dadas: meta de 40 motos por punto; la meta del administrador es una moto menos que la del asesor. No se aplican automáticamente.</span></div></div>
    ${sinFact ? '<div class="notice bad" style="margin-bottom:10px"><i class="ti ti-file-off"></i><div>Falta la hoja <b>Facturas</b>: facturados y valor se muestran en 0 hasta que exista (solicitud al Sheet).</div></div>' : ''}
    ${sinMetas ? '<div class="notice" style="margin-bottom:10px"><i class="ti ti-target-off"></i><div>Falta la hoja <b>Metas</b>: la meta se muestra en blanco.</div></div>' : ''}
    ${filas.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Asesor</th><th>Punto</th><th class="r">Asignados</th><th class="r">Contactados a tiempo</th><th class="r">Cotizados</th><th class="r">Facturados</th><th class="r">Meta</th><th class="r">% meta</th><th class="r">Valor facturado</th><th class="r">Comisión</th></tr></thead><tbody>
      ${filas.map(f => `<tr><td><b>${esc(f.p.nombre)}</b>${f.p.rolApp === 'admin' ? ' <span class="pill">Admin</span>' : ''}</td><td>${esc(f.p.sedeCanon || '')}</td>
        <td class="r num">${f.asignados}</td><td class="r num">${f.aTiempo} <span class="muted tiny">${fmtPct(pct(f.aTiempo, f.asignados))}</span></td><td class="r num">${f.cotizados}</td>
        <td class="r num">${f.facturados}${f.marcadosGanados > f.facturados ? ` <span class="pill pill-warn" title="Marcados ganados sin factura">+${f.marcadosGanados - f.facturados} sin factura</span>` : ''}</td>
        <td class="r num">${f.meta === null ? '<span class="muted">—</span>' : f.meta}</td><td class="r num">${f.meta ? fmtPct(pct(f.facturados, f.meta)) : '—'}</td>
        <td class="r num">${money(f.valor)}</td><td class="r muted">Pendiente de regla</td></tr>`).join('')}
    </tbody></table></div>` : empty('ti-users', 'No hay asesores en la hoja Equipo para este alcance.')}
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
  { grupo: 'Para clientes', icon: 'ti-calculator', nombre: 'Cotizador de motos (público)', desc: 'Enlace para publicaciones en redes y para enviar por WhatsApp. Quien cotiza entra como lead caliente "cotizado".', url: 'https://orregomejiaj-gif.github.io/crm-leads-motos/cotizador.html' }
];
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
  if (act === 'qr-usar' || act === 'qr-ia') return usarRespuestaRapida(a);
  if (['etapa', 'cita-estado', 'cita-nueva'].includes(act)) return accionAvance(act, a);
  if (act === 'ind-recargar') { S.indT = 0; S.ind = null; cargarIndicadores(); return render(); }
  if (act === 'chat-abrir') return abrirChatBandeja(a.dataset.id);
  if (act === 'ir-chat') { cerrarSheet(); S.chatSel = a.dataset.id; S.view = 'chats'; renderNav(); return render(); }
  if (act === 'chat-volver') { S.chatSel = null; S.leadAbierto = null; return render(); }
  if (act === 'chat-enviar') return enviarChat(a.dataset.id, a);
  if (act === 'chat-bot') return cambiarAtencionChat(a.dataset.id, 'bot');
  if (act === 'chat-tomar') return cambiarAtencionChat(a.dataset.id, 'asesor');
  if (act === 'copiar-acceso') { try { await navigator.clipboard.writeText(a.dataset.url); toast('Enlace copiado', 'ok'); } catch (err) { toast(a.dataset.url); } return; }
  if (act === 'abrir' && l) return abrirLead(l.id);
  if (act === 'contactado' && l) { a.disabled = true; if (await setCampo(l, 'Gestion_Asesor', 'contactado', 'Sí')) toast('Marcado como contactado', 'ok'); return refrescar(); }
  if (act === 'cotizado' && l) return moverA(l, 'Cotizado');
  if (act === 'perdido' && l) return moverA(l, 'Perdido');
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
  if (t.dataset.f !== undefined) { S.f[t.dataset.f] = t.value; if (t.dataset.f === 'punto') S.f.asesor = ''; render(); return; }
  if (t.dataset.sf !== undefined) { S.segFiltro[t.dataset.sf] = t.value; render(); return; }
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
