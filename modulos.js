/* CRM Leads Motos — módulos de la etapa 2
 * Seguimiento comercial (daily, checklist semanal, compromisos, evolución + Excel),
 * Posventa, Inventario (básicos/quiebres, quieto, descuadres) y Cruce de cotizaciones.
 * Cada módulo lee su propio repositorio (un Google Sheet por frente) solo cuando se abre.
 */
window.AKT_MODULOS = function (H) {
'use strict';
const { S, api, $, $$, esc, norm, digits, tel10, pad, num, pct, fmtPct, money, cap, uniq, sedeCanon,
  parseFecha, fmtFecha, ymd, bparts, toast, empty, kpi, bars, contar, opts, abrirSheet, cerrarSheet, confirmar } = H;
const render = () => H.render();

const D = {};            // datos cargados por módulo
const cargando = {};
const T = { seg: '', pos: 'lista', inv: 'basicos', cot: 'cruce', cfgRepos: null };
const F = { fecha: '', semana: '', punto: '', asesor: '', dias: '30', cobertura: '30', quieto: '90', estado: '', tipo: '', periodoCot: '60' };
let IMP = null;          // estado del cargador de exportes
let REPOS = null;        // estado de repositorios (Ajustes)

// ── Utilidades ───────────────────────────────────────────────────────────
const hoyTxt = () => ymd(new Date());
const fechaTxt = v => { if (!v) return ''; const s = String(v); if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); const d = parseFecha(s); return d ? ymd(d) : ''; };
const u = () => S.data.user;
const esJefe = () => u().rol === 'jefe';
const esAsesor = () => u().rol === 'asesor';
const puntosScope = () => esJefe() ? ['Itagüí', 'Los Colores'] : [u().sede];
const asesoresScope = () => S.M.asesores.filter(p => esJefe() ? (!F.punto || p.sedeCanon === F.punto) : p.sedeCanon === u().sede);
const nkey = k => norm(k).replace(/[^a-z0-9]/g, '');

function semanaKey(d) {
  const p = bparts(d), t = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const dow = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dow + 3);
  const y = t.getUTCFullYear(), j4 = new Date(Date.UTC(y, 0, 4));
  const w = 1 + Math.round(((t - j4) / 864e5 - 3 + ((j4.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${pad(w)}`;
}
function lunesDe(key) {
  const [y, w] = key.split('-W').map(Number), j4 = new Date(Date.UTC(y, 0, 4));
  return new Date(j4.getTime() - ((j4.getUTCDay() + 6) % 7) * 864e5 + (w - 1) * 7 * 864e5);
}
function semanaLabel(key) {
  const l = lunesDe(key), dom = new Date(l.getTime() + 6 * 864e5);
  const m = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `Sem ${+key.split('-W')[1]} · ${l.getUTCDate()} ${m[l.getUTCMonth()]} – ${dom.getUTCDate()} ${m[dom.getUTCMonth()]}`;
}
function semanasRecientes(n) { const out = []; for (let i = 0; i < n; i++) out.push(semanaKey(new Date(Date.now() - i * 7 * 864e5))); return uniq(out); }
const semanaDe = v => { const d = parseFecha(v); return d ? semanaKey(d) : ''; };

/** Busca en una fila de exporte la columna cuyo nombre contenga alguno de los patrones. */
function col(row, pats) {
  const ks = Object.keys(row);
  for (const p of pats) { const k = ks.find(k => nkey(k) === p); if (k) return row[k]; }
  // Coincidencia parcial solo con patrones de 4+ letras (evita que "cc" encuentre "direccion").
  for (const p of pats) { if (p.length < 4) continue; const k = ks.find(k => nkey(k).includes(p)); if (k) return row[k]; }
  return '';
}
const P = {
  ced: ['cedula', 'nit', 'identificacion', 'documento', 'numdoc', 'nrodoc', 'cc'],
  tel: ['celular', 'movil', 'telefono', 'whatsapp', 'tel'],
  mail: ['correo', 'email', 'mail'],
  fecha: ['fecha', 'fechafactura', 'fechadoc', 'fechacotizacion'],
  asesor: ['asesor', 'vendedor', 'nombrevendedor', 'usuario'],
  nombre: ['nombrecliente', 'nombre', 'razonsocial', 'cliente', 'tercero'],
  modelo: ['articulo', 'descripcion', 'referencia', 'producto', 'modelo', 'item'],
  codigo: ['codigo', 'codarticulo', 'ref'],
  bodega: ['bodega', 'sede', 'punto', 'sucursal', 'almacen', 'centrocosto'],
  cant: ['disponibilidad', 'cantidad', 'existencia', 'saldo', 'cant', 'unidades'],
  dias: ['diasinventario', 'dias'],
  valor: ['valortotal', 'total', 'valor', 'precio', 'neto', 'subtotal']
};
function claves(r) {
  const ced = digits(col(r, P.ced)), tel = tel10(col(r, P.tel)), mail = String(col(r, P.mail) || '').trim().toLowerCase();
  return { ced: ced.length >= 5 ? ced : '', tel, mail: mail.includes('@') ? mail : '' };
}
function indexar(rows) {
  const ix = { ced: {}, tel: {}, mail: {} };
  rows.forEach((r, i) => { const k = claves(r); ['ced', 'tel', 'mail'].forEach(t => { if (k[t]) (ix[t][k[t]] = ix[t][k[t]] || []).push(i); }); });
  return ix;
}
function buscar(ix, r) {
  const k = claves(r), out = new Set();
  ['ced', 'tel', 'mail'].forEach(t => { if (k[t] && ix[t][k[t]]) ix[t][k[t]].forEach(i => out.add(i)); });
  return [...out];
}
function tabs(grupo, lista) {
  return `<div class="seg" style="margin-bottom:12px">${lista.map(([v, t]) => `<button class="${T[grupo] === v ? 'on' : ''}" data-act="m-tab" data-g="${grupo}" data-v="${v}">${t}</button>`).join('')}</div>`;
}
const loading = txt => `<div class="loading"><div><i class="ti ti-loader-2 spin"></i> ${txt || 'Cargando…'}</div></div>`;
function sinRepo(nombre) {
  return `<div class="notice bad"><i class="ti ti-database-off"></i><div><b>El repositorio de ${nombre} aún no existe.</b><br>${esJefe()
    ? 'Créalo en Ajustes → Repositorios (un clic).<div style="margin-top:8px"><button class="btn btn-sm btn-dark" data-act="m-ir-repos">Ir a Repositorios</button></div>'
    : 'El Jefe Comercial debe crearlo en Ajustes → Repositorios.'}</div></div>`;
}

async function cargarMod(m, forzar) {
  if (cargando[m] || (D[m] && !forzar)) return;
  cargando[m] = true;
  try { D[m] = await api('modulo', { m }); }
  catch (e) { D[m] = { error: e.message }; }
  finally { cargando[m] = false; }
  render();
}
function datos(m) { if (!D[m]) { cargarMod(m); return null; } return D[m]; }
function errorMod(d) { return d && d.error ? `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div>${esc(d.error)}</div></div>` : ''; }
function cabecera(titulo, sub, m, extra) {
  return `<div class="page-h"><div><h2>${titulo}</h2><p class="muted small">${sub}</p></div><div class="row wrap">${extra || ''}<button class="btn btn-sm" data-act="m-recargar" data-m="${m}"><i class="ti ti-refresh"></i> Actualizar</button></div></div>`;
}

// Selectores de opción rápida (botones grandes) y contadores −/+.
const choice = (q, ops, val) => `<div class="seg" data-q="${q}" data-val="${esc(val || '')}">${ops.map(o => `<button type="button" class="${o === val ? 'on' : ''}" data-act="m-q" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
const stepper = (id, val) => `<div class="row" style="gap:4px"><button type="button" class="btn btn-sm" data-act="m-step" data-t="${id}" data-d="-1">−</button><input id="${id}" class="inp num" type="number" min="0" value="${val ?? 0}" style="width:70px;text-align:center"><button type="button" class="btn btn-sm" data-act="m-step" data-t="${id}" data-d="1">+</button></div>`;
const valQ = q => { const el = $(`[data-q="${q}"]`); return el ? el.dataset.val : ''; };
const valN = id => { const el = $('#' + id); return el ? Math.max(0, Number(el.value) || 0) : 0; };

// ═════════════════════════ SEGUIMIENTO COMERCIAL ═════════════════════════
const CHECK_DEF = [
  'Leads de la semana gestionados en el CRM (sin SLA vencidos abiertos)',
  'Cotizaciones abiertas con seguimiento registrado',
  'Facturas de la semana cargadas en el CRM',
  'Inventario del punto revisado contra el sistema',
  'Modelos básicos (los más vendidos) disponibles en exhibición',
  'Exhibición ordenada, precios y bonos visibles',
  'Solicitudes de crédito en trámite revisadas con las financieras',
  'Interesados de posventa contactados',
  'Metas de la semana socializadas con el equipo',
  'Compromisos de la semana anterior revisados con cada asesor'
];
const checkItems = () => { const c = S.M.cfg.raw.checklist_semanal_items; return c ? String(c).split('|').map(s => s.trim()).filter(Boolean) : CHECK_DEF; };

function vSeguimiento() {
  const lista = esAsesor() ? [['comp', 'Mis compromisos'], ['acomp', 'Acompañamientos']]
    : [['daily', 'Daily'], ['check', 'Checklist semanal'], ['comp', 'Compromisos'], ['evol', 'Evolución'], ['acomp', 'Acompañamientos']];
  if (!lista.some(t => t[0] === T.seg)) T.seg = lista[0][0];
  if (T.seg === 'acomp') return tabs('seg', lista) + H.vAcompanamientos();
  const d = datos('seguimiento');
  const head = cabecera('Seguimiento comercial', esAsesor() ? 'Tus compromisos de la semana y su revisión.' : 'Preguntas cortas: daily por asesor, checklist del punto y compromisos semanales.', 'seguimiento');
  if (!d) return head + tabs('seg', lista) + loading();
  if (d.error) return head + tabs('seg', lista) + errorMod(d);
  if (!d.repoOk) return head + tabs('seg', lista) + sinRepo('Seguimientos comerciales');
  const body = { daily: tDaily, check: tCheck, comp: tComp, evol: tEvol }[T.seg](d);
  return head + tabs('seg', lista) + body;
}

// ── Daily por asesor ─────────────────────────────────────────────────────
function metricasDia(asesor, fecha) {
  const mis = S.M.leads.filter(l => norm(l.asesor) === norm(asesor));
  return {
    asignados: mis.filter(l => l.asign && ymd(l.asign) === fecha).length,
    contactados: mis.filter(l => l.contactadoEn && ymd(l.contactadoEn) === fecha).length,
    sinContacto: mis.filter(l => l.estado === 'Nuevo').length
  };
}
function tDaily(d) {
  F.fecha = F.fecha || hoyTxt();
  const equipo = asesoresScope();
  const del = d.daily.filter(r => fechaTxt(r.fecha) === F.fecha);
  const hecho = n => del.find(r => norm(r.asesor) === norm(n));
  const suma = k => del.reduce((s, r) => s + (num(r[k]) || 0), 0);
  return `<div class="filters"><input type="date" class="inp" data-mch="f" data-k="fecha" value="${F.fecha}" max="${hoyTxt()}">
      ${esJefe() ? `<select class="sel" data-mch="f" data-k="punto">${opts(['Itagüí', 'Los Colores'], F.punto, 'Todos los puntos')}</select>` : ''}</div>
    <div class="grid g-kpi">${kpi('Dailies hechos', `${del.length}/${equipo.length}`, F.fecha === hoyTxt() ? 'hoy' : F.fecha, del.length >= equipo.length && equipo.length ? 'ok' : 'warn')}
      ${kpi('Contactos', suma('contactos'))}${kpi('Citas', suma('citas'))}${kpi('Cotizaciones', suma('cotizaciones'))}${kpi('Ventas', suma('ventas'), 'motos')}</div>
    <div class="section-title"><i class="ti ti-users"></i>Equipo · unos 2 minutos por asesor</div>
    <div class="list">${equipo.map(p => {
      const r = hecho(p.nombre), m = metricasDia(p.nombre, F.fecha);
      const sem = r ? { verde: 'ok', amarillo: 'warn', rojo: 'bad' }[norm(r.semaforo)] || 'na' : 'na';
      return `<article class="lead ${r ? 's-ok' : 's-warn'}"><div class="lead-top"><div><div class="lead-name">${esc(p.nombre)}</div><div class="lead-sub">${esc(p.sedeCanon)} · CRM hoy: ${m.asignados} asignados · ${m.contactados} contactados · ${m.sinContacto} sin contacto</div></div>
        ${r ? `<span class="pill pill-ok"><span class="sema ${sem}"></span>Hecho</span>` : '<span class="pill pill-warn">Pendiente</span>'}</div>
        ${r ? `<div class="lead-facts"><span>Contactos <b>${esc(r.contactos)}</b></span><span>Citas <b>${esc(r.citas)}</b></span><span>Cotiz. <b>${esc(r.cotizaciones)}</b></span><span>Ventas <b>${esc(r.ventas)}</b></span><span>Leads: <b>${esc(r.gestion_leads)}</b></span></div>${r.bloqueo ? `<div class="small"><i class="ti ti-alert-circle"></i> ${esc(r.bloqueo)}</div>` : ''}`
        : `<div class="lead-actions"><button class="btn btn-sm btn-primary" data-act="m-daily" data-a="${esc(p.nombre)}"><i class="ti ti-player-play"></i> Hacer daily</button></div>`}</article>`;
    }).join('') || empty('ti-users', 'No hay asesores en la hoja Equipo para este alcance.')}</div>`;
}
function formDaily(asesor) {
  const p = S.M.asesores.find(x => x.nombre === asesor) || {};
  const m = metricasDia(asesor, F.fecha);
  const pend = asesoresScope().filter(x => !D.seguimiento.daily.some(r => fechaTxt(r.fecha) === F.fecha && norm(r.asesor) === norm(x.nombre)));
  abrirSheet(`<div class="sheet-h"><div><h2>Daily · ${esc(asesor)}</h2><div class="muted small">${esc(p.sedeCanon || '')} · ${F.fecha} · ${pend.length} pendiente(s)</div></div><button class="icon-btn" data-close><i class="ti ti-x"></i></button></div>
  <div class="sheet-b">
    <div class="card"><div class="row wrap small"><span class="pill pill-info">CRM: ${m.asignados} leads asignados</span><span class="pill">${m.contactados} contactados</span><span class="pill ${m.sinContacto ? 'pill-bad' : 'pill-ok'}">${m.sinContacto} sin contacto ahora</span></div></div>
    <div class="card stack">
      <div><label class="f">1. ¿Gestionó todos sus leads nuevos?</label>${choice('gestion', ['Sí', 'Parcial', 'No'], m.sinContacto ? '' : 'Sí')}</div>
      <div class="grid g2">
        <div><label class="f">2. Contactos hechos (llamadas / WhatsApp)</label>${stepper('d-contactos', m.contactados)}</div>
        <div><label class="f">3. Citas agendadas</label>${stepper('d-citas', 0)}</div>
        <div><label class="f">4. Cotizaciones entregadas</label>${stepper('d-cotiz', 0)}</div>
        <div><label class="f">5. Motos vendidas</label>${stepper('d-ventas', 0)}</div>
      </div>
      <div><label class="f">6. Semáforo del día</label>${choice('semaforo', ['Verde', 'Amarillo', 'Rojo'], '')}</div>
      <div><label class="f">7. ¿Algún bloqueo o apoyo que necesite? (opcional)</label><input id="d-bloqueo" class="inp w100" maxlength="300" placeholder="Ej.: cliente espera aprobación de crédito"></div>
    </div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-act="m-daily-guardar" data-a="${esc(asesor)}"><i class="ti ti-device-floppy"></i> Guardar${pend.length > 1 ? ' y siguiente' : ''}</button></div>
  </div>`);
}
async function guardarDaily(btn) {
  const asesor = btn.dataset.a, p = S.M.asesores.find(x => x.nombre === asesor) || {};
  const gestion = valQ('gestion'), semaforo = valQ('semaforo');
  if (!gestion || !semaforo) return toast('Responde la pregunta 1 y el semáforo.', 'bad');
  const m = metricasDia(asesor, F.fecha);
  const fila = { fecha: F.fecha, punto: p.sedeCanon || '', asesor, leads_asignados_crm: m.asignados, contactados_crm: m.contactados, sin_contacto_crm: m.sinContacto,
    gestion_leads: gestion, contactos: valN('d-contactos'), citas: valN('d-citas'), cotizaciones: valN('d-cotiz'), ventas: valN('d-ventas'),
    semaforo, bloqueo: $('#d-bloqueo').value.trim() };
  btn.disabled = true;
  try {
    const r = await api('registrar', { repo: 'seguimientos', hoja: 'Daily_Asesor', fila });
    D.seguimiento.daily.push(Object.assign({ id: r.ids[0], registrado_por: u().nombre }, fila));
    toast('Daily de ' + asesor + ' guardado', 'ok');
    const sig = asesoresScope().find(x => !D.seguimiento.daily.some(rr => fechaTxt(rr.fecha) === F.fecha && norm(rr.asesor) === norm(x.nombre)));
    if (sig) formDaily(sig.nombre); else { cerrarSheet(); toast('¡Dailies del día completos!', 'ok'); }
    render();
  } catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
}

// ── Checklist semanal por punto ──────────────────────────────────────────
function tCheck(d) {
  F.semana = F.semana || semanaKey(new Date());
  const punto = esJefe() ? (F.punto || 'Itagüí') : u().sede;
  const reg = d.checklist.find(r => r.semana === F.semana && sedeCanon(r.punto) === punto);
  const hist = d.checklist.filter(r => sedeCanon(r.punto) === punto).sort((a, b) => a.semana < b.semana ? 1 : -1).slice(0, 8);
  const items = checkItems();
  let body;
  if (reg) {
    const its = (() => { try { return JSON.parse(reg.items_json); } catch (e) { return []; } })();
    body = `<div class="card"><div class="card-h"><h3>${esc(punto)} · ${semanaLabel(F.semana)}</h3><span class="pill ${num(reg.porcentaje) >= 80 ? 'pill-ok' : num(reg.porcentaje) >= 50 ? 'pill-warn' : 'pill-bad'}">${esc(reg.porcentaje)}% cumplido</span></div>
      ${its.map(i => `<div class="eval-row"><span class="small">${i.ok ? '✅' : '❌'} ${esc(i.item)}</span>${i.nota ? `<span class="small muted">${esc(i.nota)}</span>` : ''}</div>`).join('')}
      ${reg.observaciones ? `<p class="small" style="margin:8px 0 0"><b>Observaciones:</b> ${esc(reg.observaciones)}</p>` : ''}<p class="tiny muted" style="margin:6px 0 0">Registrado por ${esc(reg.registrado_por)}</p></div>`;
  } else {
    body = `<div class="card"><h3 style="margin-bottom:6px">${esc(punto)} · ${semanaLabel(F.semana)}</h3><p class="tiny muted" style="margin:0 0 6px">Marca Sí o No. La nota es opcional. Toma unos 3 minutos.</p>
      ${items.map((it, i) => `<div class="eval-row"><div class="small">${i + 1}. ${esc(it)}</div><div class="row wrap">${choice('ck' + i, ['Sí', 'No'], '')}<input class="inp" data-cknota="${i}" placeholder="Nota" style="max-width:180px"></div></div>`).join('')}
      <div style="margin-top:8px"><label class="f">Observaciones de la semana (opcional)</label><textarea class="inp" id="ck-obs"></textarea></div>
      <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn btn-primary" data-act="m-check-guardar" data-p="${esc(punto)}"><i class="ti ti-device-floppy"></i> Guardar checklist</button></div></div>`;
  }
  return `<div class="filters"><select class="sel" data-mch="f" data-k="semana">${opts(semanasRecientes(8).map(s => ({ v: s, t: semanaLabel(s) })), F.semana)}</select>
      ${esJefe() ? `<select class="sel" data-mch="f" data-k="punto">${opts(['Itagüí', 'Los Colores'], punto)}</select>` : ''}</div>${body}
    <div class="section-title"><i class="ti ti-chart-bar"></i>Últimas semanas · ${esc(punto)}</div>
    ${hist.length ? bars(hist.slice().reverse().map(h => ({ l: semanaLabel(h.semana), v: num(h.porcentaje) || 0, t: (num(h.porcentaje) || 0) + '%', cls: num(h.porcentaje) >= 80 ? 'ok' : 'warn' }))) : empty('ti-checklist', 'Aún no hay checklists de este punto.')}
    <p class="tiny muted">Las preguntas del checklist se pueden cambiar con la clave <code>checklist_semanal_items</code> en Config_App (separadas por |).</p>`;
}
async function guardarCheck(btn) {
  const items = checkItems().map((it, i) => ({ item: it, ok: valQ('ck' + i) === 'Sí', resp: valQ('ck' + i), nota: ($(`[data-cknota="${i}"]`) || {}).value || '' }));
  const faltan = items.filter(i => !i.resp).length;
  if (faltan) return toast(`Faltan ${faltan} pregunta(s) por responder.`, 'bad');
  const cumplidos = items.filter(i => i.ok).length;
  const fila = { semana: F.semana, punto: btn.dataset.p, items_json: JSON.stringify(items.map(({ item, ok, nota }) => ({ item, ok, nota }))),
    cumplidos, total: items.length, porcentaje: Math.round(cumplidos / items.length * 100), observaciones: $('#ck-obs').value.trim() };
  btn.disabled = true;
  try { const r = await api('registrar', { repo: 'seguimientos', hoja: 'Checklist_Semanal', fila }); D.seguimiento.checklist.push(Object.assign({ id: r.ids[0], registrado_por: u().nombre }, fila)); toast('Checklist guardado', 'ok'); render(); }
  catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
}

// ── Compromisos semanales del asesor ─────────────────────────────────────
const ESTADO_COMP = { cumplido: ['Cumplido', 'pill-ok'], parcial: ['Parcial', 'pill-warn'], no: ['No cumplido', 'pill-bad'] };
function ventasSemana(asesor, sem) {
  const f = (S.data.facturas || []).filter(x => norm(x.asesor) === norm(asesor) && semanaDe(x.fecha) === sem).length;
  return f;
}
function compCard(r, revisar) {
  const est = ESTADO_COMP[norm(r.revision_estado)];
  const reales = r.revision_motos_reales !== '' && r.revision_motos_reales !== undefined ? r.revision_motos_reales : null;
  return `<article class="lead ${est ? (est[1] === 'pill-ok' ? 's-ok' : est[1] === 'pill-bad' ? 's-bad' : 's-warn') : ''}">
    <div class="lead-top"><div><div class="lead-name">${esc(r.asesor)}</div><div class="lead-sub">${semanaLabel(r.semana)} · ${esc(r.punto || '')}</div></div>${est ? `<span class="pill ${est[1]}">${est[0]}</span>` : '<span class="pill">Sin revisar</span>'}</div>
    <div class="lead-facts"><span>Meta motos <b>${esc(r.meta_motos)}</b>${reales !== null ? ` · reales <b>${esc(reales)}</b>` : ''}</span><span>Citas <b>${esc(r.meta_citas)}</b></span><span>Cotiz. <b>${esc(r.meta_cotizaciones)}</b></span></div>
    <ol class="small" style="margin:0;padding-left:18px">${[r.accion_1, r.accion_2, r.accion_3].filter(Boolean).map(a => `<li>${esc(a)}</li>`).join('')}</ol>
    ${r.revision_nota ? `<div class="small muted">Revisión: ${esc(r.revision_nota)}</div>` : ''}
    ${revisar && !est ? `<div class="lead-actions"><button class="btn btn-sm btn-dark" data-act="m-comp-revisar" data-id="${esc(r.id)}"><i class="ti ti-checks"></i> Revisar</button></div>` : ''}</article>`;
}
function tComp(d) {
  const actual = semanaKey(new Date());
  if (esAsesor()) {
    const mia = d.compromisos.find(r => r.semana === actual);
    const hist = d.compromisos.filter(r => r.semana !== actual).sort((a, b) => a.semana < b.semana ? 1 : -1);
    return `${mia ? `<div class="section-title"><i class="ti ti-target"></i>Esta semana</div><div class="list">${compCard(mia)}</div>`
      : `<div class="notice info" style="margin-bottom:10px"><i class="ti ti-info-circle"></i><div>Aún no registras tus compromisos de ${semanaLabel(actual)}.</div></div><button class="btn btn-primary" data-act="m-comp-form"><i class="ti ti-plus"></i> Registrar mis compromisos</button>`}
      <div class="section-title"><i class="ti ti-history"></i>Semanas anteriores</div>${hist.length ? `<div class="list">${hist.map(r => compCard(r)).join('')}</div>` : empty('ti-target', 'Sin historial.')}`;
  }
  F.semana = F.semana || actual;
  const equipo = asesoresScope();
  const regs = d.compromisos.filter(r => r.semana === F.semana);
  const cumpl = regs.filter(r => norm(r.revision_estado) === 'cumplido').length + regs.filter(r => norm(r.revision_estado) === 'parcial').length * 0.5;
  const revisados = regs.filter(r => r.revision_estado).length;
  return `<div class="filters"><select class="sel" data-mch="f" data-k="semana">${opts(semanasRecientes(8).map(s => ({ v: s, t: semanaLabel(s) })), F.semana)}</select>
      ${esJefe() ? `<select class="sel" data-mch="f" data-k="punto">${opts(['Itagüí', 'Los Colores'], F.punto, 'Todos los puntos')}</select>` : ''}</div>
    <div class="grid g-kpi">${kpi('Registraron compromisos', `${regs.length}/${equipo.length}`)}${kpi('Revisados', `${revisados}/${regs.length}`)}${kpi('Cumplimiento', fmtPct(pct(cumpl, revisados)), 'parcial cuenta 50%', revisados ? (pct(cumpl, revisados) >= 80 ? 'ok' : 'warn') : '')}</div>
    <div class="section-title"><i class="ti ti-users"></i>${semanaLabel(F.semana)}</div>
    <div class="list">${equipo.map(p => {
      const r = regs.find(x => norm(x.asesor) === norm(p.nombre));
      return r ? compCard(r, true) : `<article class="lead s-warn"><div class="lead-top"><div><div class="lead-name">${esc(p.nombre)}</div><div class="lead-sub">${esc(p.sedeCanon)}</div></div><span class="pill pill-warn">Sin compromisos</span></div>
        <div class="lead-actions"><button class="btn btn-sm" data-act="m-comp-form" data-a="${esc(p.nombre)}"><i class="ti ti-plus"></i> Registrar por el asesor</button></div></article>`;
    }).join('') || empty('ti-users', 'Sin asesores.')}</div>`;
}
function formComp(asesor) {
  const quien = asesor || u().nombre;
  const sem = esAsesor() ? semanaKey(new Date()) : F.semana;
  abrirSheet(`<div class="sheet-h"><div><h2>Compromisos · ${esc(quien)}</h2><div class="muted small">${semanaLabel(sem)}</div></div><button class="icon-btn" data-close><i class="ti ti-x"></i></button></div>
  <div class="sheet-b"><div class="card stack">
    <div class="grid g3"><div><label class="f">Motos a vender</label>${stepper('c-motos', 0)}</div><div><label class="f">Citas a lograr</label>${stepper('c-citas', 0)}</div><div><label class="f">Cotizaciones</label>${stepper('c-cotiz', 0)}</div></div>
    <div><label class="f">Acción 1 (obligatoria)</label><input id="c-a1" class="inp w100" maxlength="200" placeholder="Ej.: llamar a los 8 cotizados de la semana pasada"></div>
    <div><label class="f">Acción 2</label><input id="c-a2" class="inp w100" maxlength="200"></div>
    <div><label class="f">Acción 3</label><input id="c-a3" class="inp w100" maxlength="200"></div>
  </div><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-act="m-comp-guardar" data-a="${esc(quien)}" data-s="${sem}"><i class="ti ti-device-floppy"></i> Guardar</button></div></div>`);
}
async function guardarComp(btn) {
  const a1 = $('#c-a1').value.trim();
  if (!a1) return toast('Escribe al menos la acción 1.', 'bad');
  const p = S.M.asesores.find(x => x.nombre === btn.dataset.a) || {};
  const fila = { semana: btn.dataset.s, asesor: btn.dataset.a, punto: p.sedeCanon || u().sede, meta_motos: valN('c-motos'), meta_citas: valN('c-citas'),
    meta_cotizaciones: valN('c-cotiz'), accion_1: a1, accion_2: $('#c-a2').value.trim(), accion_3: $('#c-a3').value.trim() };
  btn.disabled = true;
  try { const r = await api('registrar', { repo: 'seguimientos', hoja: 'Compromisos_Semana', fila }); D.seguimiento.compromisos.push(Object.assign({ id: r.ids[0] }, fila)); cerrarSheet(); toast('Compromisos guardados', 'ok'); render(); }
  catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
}
function formRevision(id) {
  const r = D.seguimiento.compromisos.find(x => x.id === id);
  if (!r) return;
  const sugerido = ventasSemana(r.asesor, r.semana);
  abrirSheet(`<div class="sheet-h"><div><h2>Revisar · ${esc(r.asesor)}</h2><div class="muted small">${semanaLabel(r.semana)} · meta ${esc(r.meta_motos)} motos</div></div><button class="icon-btn" data-close><i class="ti ti-x"></i></button></div>
  <div class="sheet-b"><div class="card stack">
    <ol class="small" style="margin:0;padding-left:18px">${[r.accion_1, r.accion_2, r.accion_3].filter(Boolean).map(a => `<li>${esc(a)}</li>`).join('')}</ol>
    <div><label class="f">¿Cumplió los compromisos?</label>${choice('rev', ['Cumplido', 'Parcial', 'No cumplido'], '')}</div>
    <div><label class="f">Motos vendidas en la semana (sugerido por Facturas: ${sugerido})</label>${stepper('r-motos', sugerido)}</div>
    <div><label class="f">Nota (opcional)</label><input id="r-nota" class="inp w100" maxlength="300"></div>
  </div><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-act="m-rev-guardar" data-id="${esc(id)}"><i class="ti ti-device-floppy"></i> Guardar revisión</button></div></div>`);
}
async function guardarRevision(btn) {
  const est = { 'Cumplido': 'cumplido', 'Parcial': 'parcial', 'No cumplido': 'no' }[valQ('rev')];
  if (!est) return toast('Elige si cumplió.', 'bad');
  const r = D.seguimiento.compromisos.find(x => x.id === btn.dataset.id);
  btn.disabled = true;
  try {
    const cambios = { revision_estado: est, revision_motos_reales: String(valN('r-motos')), revision_nota: $('#r-nota').value.trim() };
    for (const [campo, valor] of Object.entries(cambios)) {
      const res = await api('actualizar', { repo: 'seguimientos', hoja: 'Compromisos_Semana', id: r.id, campo, valor, expected: String(r[campo] ?? '') });
      if (res.conflict) { toast(res.error, 'bad'); return cargarMod('seguimiento', true); }
      r[campo] = valor;
    }
    cerrarSheet(); toast('Revisión guardada', 'ok'); render();
  } catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
}

// ── Evolución + Excel ────────────────────────────────────────────────────
function filtradoEvol(d) {
  const desde = ymd(new Date(Date.now() - (Number(F.dias) - 1) * 864e5));
  return d.daily.filter(r => fechaTxt(r.fecha) >= desde && (!F.punto || sedeCanon(r.punto) === F.punto) && (!F.asesor || norm(r.asesor) === norm(F.asesor)));
}
function serieDias(rows) {
  const out = [];
  for (let i = Number(F.dias) - 1; i >= 0; i--) {
    const k = ymd(new Date(Date.now() - i * 864e5)), del = rows.filter(r => fechaTxt(r.fecha) === k);
    const s = c => del.reduce((a, r) => a + (num(r[c]) || 0), 0);
    out.push({ fecha: k, dailies: del.length, contactos: s('contactos'), citas: s('citas'), cotizaciones: s('cotizaciones'), ventas: s('ventas'),
      verde: del.filter(r => norm(r.semaforo) === 'verde').length, amarillo: del.filter(r => norm(r.semaforo) === 'amarillo').length, rojo: del.filter(r => norm(r.semaforo) === 'rojo').length });
  }
  return out;
}
function mini(titulo, serie, campo, cls) {
  const max = Math.max(1, ...serie.map(s => s[campo])), tot = serie.reduce((a, s) => a + s[campo], 0);
  return `<div class="card"><div class="card-h"><h4>${titulo}</h4><b class="num">${tot}</b></div><div class="cols-chart" style="height:80px">${serie.map(s => `<div class="c" style="height:${s[campo] / max * 100}%;${cls ? 'background:var(--ink-2)' : ''}" title="${s.fecha}: ${s[campo]}"></div>`).join('')}</div>
    <div class="row between tiny muted"><span>${serie[0].fecha.slice(5)}</span><span>${serie[serie.length - 1].fecha.slice(5)}</span></div></div>`;
}
function tEvol(d) {
  const rows = filtradoEvol(d), serie = serieDias(rows);
  const porAsesor = uniq(rows.map(r => r.asesor)).map(a => {
    const mis = rows.filter(r => r.asesor === a), s = c => mis.reduce((x, r) => x + (num(r[c]) || 0), 0);
    const comps = d.compromisos.filter(c => norm(c.asesor) === norm(a) && c.revision_estado);
    const cum = comps.reduce((x, c) => x + (norm(c.revision_estado) === 'cumplido' ? 1 : norm(c.revision_estado) === 'parcial' ? 0.5 : 0), 0);
    return { a, n: mis.length, contactos: s('contactos'), citas: s('citas'), cotizaciones: s('cotizaciones'), ventas: s('ventas'),
      verde: pct(mis.filter(r => norm(r.semaforo) === 'verde').length, mis.length), comp: pct(cum, comps.length) };
  }).sort((x, y) => y.ventas - x.ventas || y.contactos - x.contactos);
  const checks = d.checklist.filter(c => !F.punto || sedeCanon(c.punto) === F.punto).sort((a, b) => a.semana > b.semana ? 1 : -1).slice(-16);
  return `<div class="filters">
      <select class="sel" data-mch="f" data-k="dias">${opts([{ v: '14', t: 'Últimos 14 días' }, { v: '30', t: 'Últimos 30 días' }, { v: '60', t: 'Últimos 60 días' }, { v: '90', t: 'Últimos 90 días' }], F.dias)}</select>
      ${esJefe() ? `<select class="sel" data-mch="f" data-k="punto">${opts(['Itagüí', 'Los Colores'], F.punto, 'Todos los puntos')}</select>` : ''}
      <select class="sel" data-mch="f" data-k="asesor">${opts(asesoresScope().map(p => p.nombre), F.asesor, 'Todos los asesores')}</select>
      <button class="btn btn-ok" data-act="m-excel"><i class="ti ti-file-spreadsheet"></i> Descargar Excel</button></div>
    <div class="grid g-kpi">${kpi('Dailies registrados', rows.length)}${kpi('Contactos', rows.reduce((a, r) => a + (num(r.contactos) || 0), 0))}${kpi('Citas', rows.reduce((a, r) => a + (num(r.citas) || 0), 0))}${kpi('Ventas', rows.reduce((a, r) => a + (num(r.ventas) || 0), 0), 'motos')}</div>
    <div class="section-title"><i class="ti ti-chart-line"></i>Evolución diaria</div>
    <div class="grid g2">${mini('Contactos', serie, 'contactos')}${mini('Citas', serie, 'citas', 1)}${mini('Cotizaciones', serie, 'cotizaciones', 1)}${mini('Ventas', serie, 'ventas')}</div>
    <div class="section-title"><i class="ti ti-users"></i>Por asesor</div>
    ${porAsesor.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Asesor</th><th class="r">Dailies</th><th class="r">Contactos</th><th class="r">Citas</th><th class="r">Cotiz.</th><th class="r">Ventas</th><th class="r">Días en verde</th><th class="r">Cumpl. compromisos</th></tr></thead><tbody>
      ${porAsesor.map(x => `<tr><td><b>${esc(x.a)}</b></td><td class="r num">${x.n}</td><td class="r num">${x.contactos}</td><td class="r num">${x.citas}</td><td class="r num">${x.cotizaciones}</td><td class="r num">${x.ventas}</td><td class="r num">${fmtPct(x.verde)}</td><td class="r num">${fmtPct(x.comp)}</td></tr>`).join('')}
    </tbody></table></div>` : empty('ti-chart-line', 'No hay dailies en el período.')}
    <div class="section-title"><i class="ti ti-checklist"></i>Checklist semanal</div>
    ${checks.length ? bars(checks.map(c => ({ l: `${sedeCanon(c.punto)} · ${semanaLabel(c.semana)}`, v: num(c.porcentaje) || 0, t: (num(c.porcentaje) || 0) + '%', cls: num(c.porcentaje) >= 80 ? 'ok' : 'warn' }))) : empty('ti-checklist', 'Sin checklists.')}`;
}
function cargarScript(src) {
  return new Promise((res, rej) => { if ([...document.scripts].some(s => s.src === src)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('No se pudo cargar ' + src)); document.head.appendChild(s); });
}
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
async function excelSeguimiento() {
  try { await cargarScript(XLSX_URL); } catch (e) { return toast(e.message, 'bad'); }
  const d = D.seguimiento, rows = filtradoEvol(d), serie = serieDias(rows);
  const wb = XLSX.utils.book_new();
  const hoja = (data, nombre) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ sin_datos: '' }]), nombre);
  hoja(serie.map(s => ({ Fecha: s.fecha, Dailies: s.dailies, Contactos: s.contactos, Citas: s.citas, Cotizaciones: s.cotizaciones, Ventas: s.ventas, Verde: s.verde, Amarillo: s.amarillo, Rojo: s.rojo })), 'Evolucion_diaria');
  hoja(rows.map(r => ({ Fecha: fechaTxt(r.fecha), Punto: r.punto, Asesor: r.asesor, 'Leads asignados (CRM)': num(r.leads_asignados_crm), 'Contactados (CRM)': num(r.contactados_crm), 'Sin contacto (CRM)': num(r.sin_contacto_crm),
    'Gestionó leads': r.gestion_leads, Contactos: num(r.contactos), Citas: num(r.citas), Cotizaciones: num(r.cotizaciones), Ventas: num(r.ventas), Semaforo: r.semaforo, Bloqueo: r.bloqueo, 'Registrado por': r.registrado_por })), 'Daily_Asesor');
  const ck = [];
  d.checklist.filter(c => !F.punto || sedeCanon(c.punto) === F.punto).forEach(c => {
    let its = []; try { its = JSON.parse(c.items_json); } catch (e) { /* noop */ }
    its.forEach(i => ck.push({ Semana: c.semana, Punto: c.punto, Pregunta: i.item, Cumple: i.ok ? 'Sí' : 'No', Nota: i.nota, '% semana': num(c.porcentaje) }));
  });
  hoja(ck, 'Checklist_Semanal');
  hoja(d.compromisos.filter(c => (!F.punto || sedeCanon(c.punto) === F.punto) && (!F.asesor || norm(c.asesor) === norm(F.asesor))).map(c => ({ Semana: c.semana, Asesor: c.asesor, Punto: c.punto,
    'Meta motos': num(c.meta_motos), 'Meta citas': num(c.meta_citas), 'Meta cotizaciones': num(c.meta_cotizaciones), 'Acción 1': c.accion_1, 'Acción 2': c.accion_2, 'Acción 3': c.accion_3,
    Revision: (ESTADO_COMP[norm(c.revision_estado)] || ['Sin revisar'])[0], 'Motos reales': num(c.revision_motos_reales), 'Nota revisión': c.revision_nota })), 'Compromisos');
  XLSX.writeFile(wb, `seguimiento_comercial_${hoyTxt()}.xlsx`);
  toast('Excel descargado', 'ok');
}

// ═════════════════════════════════ POSVENTA ══════════════════════════════
const TIPOS_POS = ['Accesorios', 'Repuestos', 'Revisión / mantenimiento', 'Garantía', 'Otro'];
const ESTADOS_POS = ['Nuevo', 'Contactado', 'Agendado', 'Ingresó / compró', 'Sin interés'];
const ORIGENES_POS = ['Punto de venta', 'WhatsApp', 'Llamada', 'Redes sociales', 'Referido', 'Otro'];
function cruceTaller(d) {
  const ix = indexar(d.ingresos);
  return d.interesados.map(r => {
    const desde = parseFecha(r.registrado);
    const hits = buscar(ix, r).map(i => d.ingresos[i]).filter(g => { const f = parseFecha(col(g, P.fecha)); return !f || !desde || f >= new Date(desde.getTime() - 864e5); });
    return { r, hits, valor: hits.reduce((s, g) => s + (num(col(g, P.valor)) || 0), 0) };
  });
}
function vPosventa() {
  const lista = [['lista', 'Interesados']].concat(esAsesor() && norm(u().recibe) !== 'posventa' ? [] : [['efect', 'Efectividad']]).concat(esAsesor() ? [] : [['cargar', 'Cargar ingresos de taller']]);
  if (!lista.some(t => t[0] === T.pos)) T.pos = 'lista';
  const d = datos('posventa');
  const head = cabecera('Posventa', 'Interesados en accesorios, repuestos y revisiones. No entran como lead; se cruzan con los ingresos al taller.', 'posventa',
    d && d.repoOk ? '<button class="btn btn-sm btn-primary" data-act="m-pos-nuevo"><i class="ti ti-plus"></i> Registrar interesado</button>' : '');
  if (!d) return head + tabs('pos', lista) + loading();
  if (d.error) return head + tabs('pos', lista) + errorMod(d);
  if (!d.repoOk) return head + tabs('pos', lista) + sinRepo('Posventa');
  if (T.pos === 'cargar') return head + tabs('pos', lista) + importador('posventa', [['Ingresos_Taller', 'Ingresos / órdenes de taller (Síntesis)']]);
  const cruce = cruceTaller(d);
  if (T.pos === 'efect') return head + tabs('pos', lista) + tEfectividad(d, cruce);
  const vis = cruce.filter(x => (!F.estado || x.r.estado === F.estado) && (!F.tipo || x.r.tipo === F.tipo) && (!F.punto || sedeCanon(x.r.punto) === F.punto))
    .sort((a, b) => String(b.r.registrado) > String(a.r.registrado) ? 1 : -1);
  const vencidas = cruce.filter(x => x.r.fecha_proxima && fechaTxt(x.r.fecha_proxima) < hoyTxt() && !['Ingresó / compró', 'Sin interés'].includes(x.r.estado)).length;
  return head + tabs('pos', lista) + `<div class="grid g-kpi">${kpi('Interesados', cruce.length)}${kpi('Por contactar', cruce.filter(x => !x.r.estado || x.r.estado === 'Nuevo').length, '', 'warn')}${kpi('Seguimientos vencidos', vencidas, 'fecha próxima ya pasó', vencidas ? 'bad' : 'ok')}${kpi('Ingresaron al taller', cruce.filter(x => x.hits.length).length, 'cruce por cédula, celular o correo', 'ok')}</div>
    <div class="filters" style="margin-top:12px"><select class="sel" data-mch="f" data-k="estado">${opts(ESTADOS_POS, F.estado, 'Todos los estados')}</select><select class="sel" data-mch="f" data-k="tipo">${opts(TIPOS_POS, F.tipo, 'Todos los tipos')}</select>
      ${esJefe() ? `<select class="sel" data-mch="f" data-k="punto">${opts(['Itagüí', 'Los Colores'], F.punto, 'Todos los puntos')}</select>` : ''}</div>
    ${vis.length ? `<div class="list">${vis.slice(0, 200).map(({ r, hits }) => {
      const t = tel10(r.celular), venc = r.fecha_proxima && fechaTxt(r.fecha_proxima) < hoyTxt() && !['Ingresó / compró', 'Sin interés'].includes(r.estado);
      return `<article class="lead ${hits.length ? 's-ok' : venc ? 's-bad' : ''}"><div class="lead-top"><div><div class="lead-name">${esc(r.nombre)}</div><div class="lead-sub">${esc(r.punto)} · ${fmtFecha(parseFecha(r.registrado), false)} · por ${esc(r.registrado_por)}</div></div><span class="pill pill-info">${esc(r.tipo)}</span></div>
        ${r.detalle ? `<div class="small">${esc(r.detalle)}</div>` : ''}
        <div class="lead-facts">${t ? `<span><i class="ti ti-phone"></i>${esc(t)}</span>` : ''}${r.cedula ? `<span><i class="ti ti-id"></i>${esc(r.cedula)}</span>` : ''}${r.moto_cliente ? `<span><i class="ti ti-motorbike"></i>${esc(r.moto_cliente)}</span>` : ''}
          ${hits.length ? `<span class="pill pill-ok">✓ Ingresó al taller (${hits.length})</span>` : ''}</div>
        <div class="grid g2"><select class="sel" data-mch="pos-estado" data-id="${esc(r.id)}">${opts(ESTADOS_POS, r.estado || 'Nuevo')}</select>
          <input type="date" class="inp" data-mch="pos-fecha" data-id="${esc(r.id)}" value="${fechaTxt(r.fecha_proxima)}" title="Próximo seguimiento"></div>
        ${r.nota_gestion ? `<div class="small muted">Última gestión: ${esc(r.nota_gestion)}</div>` : ''}
        <div class="lead-actions">${t ? `<a class="btn btn-sm btn-wa" href="https://wa.me/57${t}" target="_blank" rel="noopener"><i class="ti ti-brand-whatsapp"></i> WhatsApp</a>` : ''}<button class="btn btn-sm" data-act="m-pos-nota" data-id="${esc(r.id)}"><i class="ti ti-notes"></i> Registrar gestión</button></div></article>`;
    }).join('')}</div>` : empty('ti-tool', 'No hay interesados con estos filtros.')}`;
}
function tEfectividad(d, cruce) {
  const conv = cruce.filter(x => x.hits.length || x.r.estado === 'Ingresó / compró');
  const valor = cruce.reduce((s, x) => s + x.valor, 0);
  const ixInt = indexar(d.interesados);
  const sinPrevio = d.ingresos.filter(g => !buscar(ixInt, g).length).length;
  const porTipo = TIPOS_POS.map(t => { const g = cruce.filter(x => x.r.tipo === t); const c = g.filter(x => x.hits.length || x.r.estado === 'Ingresó / compró').length; return { l: t, v: pct(c, g.length) || 0, t: `${c}/${g.length}`, cls: 'ok' }; }).filter(x => x.t !== '0/0');
  const porQuien = uniq(cruce.map(x => x.r.registrado_por)).map(n => { const g = cruce.filter(x => x.r.registrado_por === n); const c = g.filter(x => x.hits.length || x.r.estado === 'Ingresó / compró').length; return { n, total: g.length, c, contact: g.filter(x => x.r.estado && x.r.estado !== 'Nuevo').length }; });
  return `<div class="grid g-kpi">${kpi('Interesados', cruce.length)}${kpi('Contactados', cruce.filter(x => x.r.estado && x.r.estado !== 'Nuevo').length)}${kpi('Convertidos', conv.length, fmtPct(pct(conv.length, cruce.length)) + ' efectividad', 'ok')}${kpi('Valor de sus ingresos', money(valor), 'según el exporte de taller')}${kpi('Ingresos sin seguimiento previo', sinPrevio, 'clientes que llegaron sin registro', '')}</div>
    <div class="grid g2" style="margin-top:12px"><div class="card"><h3 style="margin-bottom:10px">Efectividad por tipo</h3>${bars(porTipo, { vacio: 'Sin datos.' })}</div>
    <div class="card"><h3 style="margin-bottom:10px">Por quien registra</h3>${porQuien.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Persona</th><th class="r">Registrados</th><th class="r">Contactados</th><th class="r">Convertidos</th><th class="r">%</th></tr></thead><tbody>${porQuien.map(x => `<tr><td>${esc(x.n)}</td><td class="r num">${x.total}</td><td class="r num">${x.contact}</td><td class="r num">${x.c}</td><td class="r num">${fmtPct(pct(x.c, x.total))}</td></tr>`).join('')}</tbody></table></div>` : empty('ti-users', 'Sin datos.')}</div></div>
    <p class="tiny muted">Convertido = el cliente aparece en el exporte de ingresos de taller (por cédula, celular o correo) desde el día en que se registró, o su estado es “Ingresó / compró”. ${d.ingresos.length} ingresos cargados.</p>`;
}
function formPosventa() {
  abrirSheet(`<div class="sheet-h"><div><h2>Registrar interesado de posventa</h2><div class="muted small">No entra como lead; queda para seguimiento.</div></div><button class="icon-btn" data-close><i class="ti ti-x"></i></button></div>
  <div class="sheet-b"><div class="card stack">
    <div><label class="f">Nombre *</label><input id="p-nombre" class="inp w100" maxlength="120"></div>
    <div class="grid g3"><div><label class="f">Celular</label><input id="p-cel" class="inp w100" inputmode="tel" maxlength="20"></div><div><label class="f">Cédula</label><input id="p-ced" class="inp w100" inputmode="numeric" maxlength="15"></div><div><label class="f">Correo</label><input id="p-mail" class="inp w100" type="email" maxlength="120"></div></div>
    <div><label class="f">¿Qué le interesa? *</label>${choice('ptipo', TIPOS_POS, '')}</div>
    <div><label class="f">Detalle</label><input id="p-det" class="inp w100" maxlength="300" placeholder="Ej.: casco talla M, kit de arrastre NKD 125, revisión de 5.000 km"></div>
    <div class="grid g2"><div><label class="f">Moto del cliente</label><input id="p-moto" class="inp w100" maxlength="80"></div><div><label class="f">Origen</label><select id="p-origen" class="sel w100">${opts(ORIGENES_POS, 'Punto de venta')}</select></div></div>
    ${esJefe() ? `<div><label class="f">Punto</label><select id="p-punto" class="sel w100">${opts(['Itagüí', 'Los Colores'], 'Itagüí')}</select></div>` : ''}
    <div class="grid g2"><div><label class="f">Próxima acción</label><input id="p-acc" class="inp w100" maxlength="150" placeholder="Ej.: enviar precio por WhatsApp"></div><div><label class="f">Fecha</label><input id="p-fecha" type="date" class="inp w100" min="${hoyTxt()}"></div></div>
  </div><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-act="m-pos-guardar"><i class="ti ti-device-floppy"></i> Guardar</button></div></div>`);
}
async function guardarPosventa(btn) {
  const fila = { nombre: $('#p-nombre').value.trim(), celular: digits($('#p-cel').value), cedula: digits($('#p-ced').value), correo: $('#p-mail').value.trim(),
    tipo: valQ('ptipo'), detalle: $('#p-det').value.trim(), moto_cliente: $('#p-moto').value.trim(), origen: $('#p-origen').value,
    punto: esJefe() ? $('#p-punto').value : u().sede, estado: 'Nuevo', proxima_accion: $('#p-acc').value.trim(), fecha_proxima: $('#p-fecha').value };
  if (!fila.nombre || !fila.tipo) return toast('Nombre y tipo son obligatorios.', 'bad');
  if (!fila.celular && !fila.cedula && !fila.correo) return toast('Escribe al menos celular, cédula o correo (para cruzar con el taller).', 'bad');
  btn.disabled = true;
  try { const r = await api('registrar', { repo: 'posventa', hoja: 'Interesados', fila }); D.posventa.interesados.push(Object.assign({ id: r.ids[0], registrado: new Date().toISOString(), registrado_por: u().nombre }, fila)); cerrarSheet(); toast('Interesado registrado', 'ok'); render(); }
  catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
}
async function actualizarPos(id, campo, valor) {
  const r = D.posventa.interesados.find(x => x.id === id);
  if (!r) return;
  try {
    const res = await api('actualizar', { repo: 'posventa', hoja: 'Interesados', id, campo, valor, expected: campo === 'fecha_proxima' ? fechaTxt(r[campo]) : String(r[campo] ?? '') });
    if (res.conflict) { toast(res.error, 'bad'); return cargarMod('posventa', true); }
    r[campo] = valor; toast('Guardado', 'ok'); render();
  } catch (e) { toast(e.message, 'bad'); }
}
function formNota(id) {
  const r = D.posventa.interesados.find(x => x.id === id);
  abrirSheet(`<div class="sheet-b"><h3>Gestión · ${esc(r.nombre)}</h3><textarea id="pn-nota" class="inp" maxlength="500" placeholder="¿Qué se habló? ¿Qué sigue?">${esc(r.nota_gestion || '')}</textarea>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-act="m-pos-nota-g" data-id="${esc(id)}">Guardar</button></div></div>`, true);
}

// ═════════════════════════════════ INVENTARIO ════════════════════════════
function prepInv(d) {
  const eq = {};
  (d.equivalencias || []).forEach(e => { if (e.articulo_interno) eq[nkey(e.articulo_interno)] = e.modelo_comercial; if (e.codigo_interno && !eq[nkey(e.codigo_interno)]) eq[nkey(e.codigo_interno)] = e.modelo_comercial; });
  const modeloDe = r => { const a = String(col(r, P.modelo) || '').trim(), c = String(col(r, P.codigo) || '').trim(); return eq[nkey(a)] || eq[nkey(c)] || a || c || 'Sin modelo'; };
  const puntoDe = r => sedeCanon(col(r, P.bodega)) || 'Sin punto';
  const esMoto = r => !/repuesto|accesorio|taller/.test(norm(col(r, P.bodega)));
  const ultimo = {};
  d.sistema.forEach(r => { const p = puntoDe(r), l = fechaTxt(r._lote); if (!ultimo[p] || l > ultimo[p]) ultimo[p] = l; });
  const stock = d.sistema.filter(r => esMoto(r) && fechaTxt(r._lote) === ultimo[puntoDe(r)]).map(r => ({ punto: puntoDe(r), modelo: modeloDe(r), cant: num(col(r, P.cant)) ?? 1, dias: num(col(r, P.dias)), presentacion: r.presentacion || '' }));
  const ventas = d.facturacion.filter(esMoto).map(r => ({ punto: puntoDe(r), modelo: modeloDe(r), cant: num(col(r, ['cantidad', 'cant', 'unidades'])) || 1, fecha: parseFecha(col(r, P.fecha)) }));
  return { stock, ventas, ultimo, modeloDe };
}
function vInventario() {
  const lista = [['basicos', 'Básicos y quiebres'], ['quieto', 'Inventario quieto'], ['descuadres', 'Descuadres y conteo'], ['cargar', 'Cargar exportes']];
  const d = datos('inventario');
  const head = cabecera('Inventario real del punto', 'Inventario del sistema (Síntesis) vs unidades facturadas y conteo físico. Costos y seriales nunca se muestran.', 'inventario');
  if (!d) return head + tabs('inv', lista) + loading();
  if (d.error) return head + tabs('inv', lista) + errorMod(d);
  if (!d.repoOk) return head + tabs('inv', lista) + sinRepo('Inventario');
  if (T.inv === 'cargar') return head + tabs('inv', lista) + importador('inventario', [['Inventario_Sistema', 'Inventario del sistema (corte de Síntesis)'], ['Facturacion', 'Facturación de motos (Síntesis)']]);
  const I = prepInv(d);
  if (!d.sistema.length) return head + tabs('inv', lista) + empty('ti-building-warehouse', 'Aún no hay un corte de inventario cargado. Usa “Cargar exportes”.');
  const puntos = uniq(I.stock.map(s => s.punto));
  const pSel = esJefe() ? F.punto : u().sede;
  const filtroP = x => !pSel || x.punto === pSel;
  const cortes = Object.entries(I.ultimo).map(([p, l]) => `${p}: ${l}`).join(' · ');
  const filtros = `<div class="filters">${esJefe() ? `<select class="sel" data-mch="f" data-k="punto">${opts(puntos, F.punto, 'Todos los puntos')}</select>` : ''}
    ${T.inv !== 'descuadres' ? `<select class="sel" data-mch="f" data-k="dias">${opts([{ v: '30', t: 'Ventas últimos 30 días' }, { v: '60', t: 'Ventas últimos 60 días' }, { v: '90', t: 'Ventas últimos 90 días' }], F.dias)}</select>` : ''}
    ${T.inv === 'basicos' ? `<label class="row small">Cobertura mínima <input class="inp" type="number" min="1" data-mch="f" data-k="cobertura" value="${esc(F.cobertura)}" style="width:70px"> días</label>` : ''}
    ${T.inv === 'quieto' ? `<label class="row small">Quieto desde <input class="inp" type="number" min="1" data-mch="f" data-k="quieto" value="${esc(F.quieto)}" style="width:70px"> días</label>` : ''}</div>
    <p class="tiny muted" style="margin:-4px 0 10px">Último corte: ${esc(cortes)} · ${d.facturacion.length} filas de facturación cargadas. Los umbrales son ajustables.</p>`;
  const N = Number(F.dias), desde = new Date(Date.now() - N * 864e5);
  const ventasP = I.ventas.filter(v => filtroP(v) && v.fecha && v.fecha >= desde);
  const stockP = I.stock.filter(filtroP);
  if (T.inv === 'basicos') {
    const modelos = uniq(stockP.map(s => s.modelo).concat(ventasP.map(v => v.modelo)));
    const demanda = {}; S.M.leads.filter(l => l.asign && l.asign >= desde && l.raw.modelo_interes && (!pSel || l.sede === pSel)).forEach(l => { demanda[nkey(l.raw.modelo_interes)] = (demanda[nkey(l.raw.modelo_interes)] || 0) + 1; });
    const filas = modelos.map(m => {
      const st = stockP.filter(s => s.modelo === m).reduce((a, s) => a + s.cant, 0), vt = ventasP.filter(v => v.modelo === m).reduce((a, v) => a + v.cant, 0);
      const cob = vt ? Math.round(st / (vt / N)) : null, dem = demanda[nkey(m)] || 0;
      const est = vt && !st ? ['Quiebre', 'pill-bad', 0] : vt && cob < Number(F.cobertura) ? ['Por agotarse', 'pill-warn', 1] : !vt && dem && !st ? ['Demanda sin stock', 'pill-bad', 0] : !vt && st ? ['Sin ventas', '', 3] : ['OK', 'pill-ok', 2];
      return { m, st, vt, cob, dem, est };
    }).sort((a, b) => a.est[2] - b.est[2] || b.vt - a.vt);
    const n = k => filas.filter(f => f.est[0] === k).length;
    return head + tabs('inv', lista) + filtros + `<div class="grid g-kpi">${kpi('Quiebres', n('Quiebre'), 'se vende y no hay', n('Quiebre') ? 'bad' : 'ok')}${kpi('Por agotarse', n('Por agotarse'), `cobertura < ${F.cobertura} días`, n('Por agotarse') ? 'warn' : 'ok')}${kpi('Demanda sin stock', n('Demanda sin stock'), 'piden en leads y no hay')}${kpi('Unidades en sistema', stockP.reduce((a, s) => a + s.cant, 0))}${kpi('Vendidas', ventasP.reduce((a, v) => a + v.cant, 0), `últimos ${N} días`)}</div>
      <div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Modelo</th><th>Estado</th><th class="r">Vendidas ${N} d</th><th class="r">Existencias</th><th class="r">Cobertura (días)</th><th class="r">Leads que la piden</th></tr></thead><tbody>
      ${filas.map(f => `<tr><td><b>${esc(f.m)}</b></td><td><span class="pill ${f.est[1]}">${f.est[0]}</span></td><td class="r num">${f.vt}</td><td class="r num">${f.st}</td><td class="r num">${f.cob === null ? '—' : f.cob}</td><td class="r num">${f.dem || '—'}</td></tr>`).join('')}
      </tbody></table></div><p class="tiny muted">Básicos = los modelos que más se venden; deben estar siempre. Cobertura = existencias ÷ ventas diarias promedio del período.</p>`;
  }
  if (T.inv === 'quieto') {
    const vendidos = new Set(ventasP.map(v => v.modelo));
    const umbral = Number(F.quieto);
    const quietos = stockP.filter(s => s.dias !== null && s.dias >= umbral).sort((a, b) => b.dias - a.dias);
    const rangos = [[0, 30], [31, 60], [61, 90], [91, 180], [181, 99999]].map(([a, b]) => ({ l: b > 9999 ? `Más de ${a - 1} días` : `${a}–${b} días`, v: stockP.filter(s => s.dias !== null && s.dias >= a && s.dias <= b).reduce((x, s) => x + s.cant, 0) }));
    return head + tabs('inv', lista) + filtros + `<div class="grid g2"><div class="card"><h3 style="margin-bottom:10px">Antigüedad del inventario (unidades)</h3>${bars(rangos, { cls: 'alt' })}</div>
      <div class="card"><h3 style="margin-bottom:10px">Resumen</h3><div class="grid g-kpi">${kpi(`Quietas ≥ ${umbral} días`, quietos.reduce((a, s) => a + s.cant, 0), '', quietos.length ? 'warn' : 'ok')}${kpi('De modelos sin ventas', quietos.filter(s => !vendidos.has(s.modelo)).reduce((a, s) => a + s.cant, 0), `en ${N} días`, 'bad')}</div></div></div>
      ${quietos.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Modelo</th><th>Presentación</th><th>Punto</th><th class="r">Días en inventario</th><th>Ventas del modelo (${N} d)</th></tr></thead><tbody>
      ${quietos.map(s => `<tr><td><b>${esc(s.modelo)}</b></td><td>${esc(s.presentacion)}</td><td>${esc(s.punto)}</td><td class="r num">${s.dias}</td><td>${vendidos.has(s.modelo) ? '<span class="pill pill-ok">Sí se vende</span>' : '<span class="pill pill-bad">Sin ventas</span>'}</td></tr>`).join('')}</tbody></table></div>` : empty('ti-mood-check', 'No hay unidades por encima del umbral.')}`;
  }
  // Descuadres y conteo físico
  const conteos = d.conteos.filter(c => !pSel || sedeCanon(c.punto) === pSel);
  const ultFecha = {}; conteos.forEach(c => { const p = sedeCanon(c.punto), f = fechaTxt(c.fecha); if (!ultFecha[p] || f > ultFecha[p]) ultFecha[p] = f; });
  const ult = conteos.filter(c => fechaTxt(c.fecha) === ultFecha[sedeCanon(c.punto)]);
  const desc = ult.filter(c => (num(c.diferencia) || 0) !== 0);
  return head + tabs('inv', lista) + filtros + `<div class="row wrap" style="margin-bottom:12px">${(esJefe() ? puntos : [u().sede]).map(p => `<button class="btn btn-primary" data-act="m-conteo" data-p="${esc(p)}"><i class="ti ti-clipboard-list"></i> Nuevo conteo físico · ${esc(p)}</button>`).join('')}</div>
    <div class="grid g-kpi">${Object.entries(ultFecha).map(([p, f]) => kpi(`Último conteo ${p}`, f, `${ult.filter(c => sedeCanon(c.punto) === p && (num(c.diferencia) || 0) !== 0).length} modelos con diferencia`, ult.some(c => sedeCanon(c.punto) === p && (num(c.diferencia) || 0) !== 0) ? 'warn' : 'ok')).join('') || kpi('Conteos', 0, 'aún no hay conteos físicos')}</div>
    ${desc.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Punto</th><th>Modelo</th><th class="r">Sistema</th><th class="r">Físico</th><th class="r">Diferencia</th><th>Observación</th></tr></thead><tbody>
      ${desc.map(c => `<tr><td>${esc(c.punto)}</td><td><b>${esc(c.modelo)}</b></td><td class="r num">${esc(c.cantidad_sistema)}</td><td class="r num">${esc(c.cantidad_fisica)}</td><td class="r num"><span class="pill ${num(c.diferencia) < 0 ? 'pill-bad' : 'pill-warn'}">${num(c.diferencia) > 0 ? '+' : ''}${esc(c.diferencia)}</span></td><td style="white-space:normal">${esc(c.observacion)}</td></tr>`).join('')}</tbody></table></div>`
      : ult.length ? `<div class="notice ok" style="margin-top:12px"><i class="ti ti-circle-check"></i><div>El último conteo cuadra con el sistema.</div></div>` : ''}`;
}
function formConteo(punto) {
  const I = prepInv(D.inventario);
  const porModelo = {}; I.stock.filter(s => s.punto === punto).forEach(s => { porModelo[s.modelo] = (porModelo[s.modelo] || 0) + s.cant; });
  const modelos = Object.keys(porModelo).sort();
  abrirSheet(`<div class="sheet-h"><div><h2>Conteo físico · ${esc(punto)}</h2><div class="muted small">Corte del sistema: ${esc(I.ultimo[punto] || '—')}. Cuenta las motos que hay en el punto.</div></div><button class="icon-btn" data-close><i class="ti ti-x"></i></button></div>
  <div class="sheet-b"><div class="card">${modelos.map((m, i) => `<div class="eval-row"><div class="small"><b>${esc(m)}</b><br><span class="muted">Sistema: ${porModelo[m]}</span></div><div class="row">${stepper('cf-' + i, porModelo[m])}<input class="inp" data-cfobs="${i}" placeholder="Obs." style="max-width:140px"></div></div>`).join('') || empty('ti-box-off', 'No hay modelos en el corte de este punto.')}</div>
  <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-act="m-conteo-guardar" data-p="${esc(punto)}"><i class="ti ti-device-floppy"></i> Guardar conteo</button></div></div>`);
  S._conteo = { punto, modelos, porModelo };
}
async function guardarConteo(btn) {
  const C = S._conteo, fecha = hoyTxt();
  const filas = C.modelos.map((m, i) => { const f = valN('cf-' + i); return { fecha, punto: C.punto, modelo: m, cantidad_sistema: C.porModelo[m], cantidad_fisica: f, diferencia: f - C.porModelo[m], observacion: ($(`[data-cfobs="${i}"]`) || {}).value || '' }; });
  if (!filas.length) return;
  btn.disabled = true;
  try { const r = await api('registrar', { repo: 'inventario', hoja: 'Conteo_Fisico', filas }); filas.forEach((f, i) => D.inventario.conteos.push(Object.assign({ id: r.ids[i] }, f))); cerrarSheet(); toast(`Conteo guardado: ${filas.filter(f => f.diferencia).length} diferencia(s)`, 'ok'); render(); }
  catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
}

// ═══════════════════════════════ COTIZACIONES ════════════════════════════
function vCotizaciones() {
  const lista = [['cruce', 'Cruce Síntesis vs CRM'], ['cargar', 'Cargar exportes']];
  const d = datos('cotizaciones');
  const head = cabecera('Cotizaciones', 'Exporte de Síntesis vs importación del CRM, cruzados por cédula, celular o correo.', 'cotizaciones');
  if (!d) return head + tabs('cot', lista) + loading();
  if (d.error) return head + tabs('cot', lista) + errorMod(d);
  if (!d.repoOk) return head + tabs('cot', lista) + sinRepo('Cotizaciones');
  if (T.cot === 'cargar') return head + tabs('cot', lista) + importador('cotizaciones', [['Cotizaciones_Sintesis', 'Cotizaciones exportadas de Síntesis'], ['Cotizaciones_CRM', 'Cotizaciones importadas del CRM']]);
  const desde = F.periodoCot === 'todo' ? null : new Date(Date.now() - Number(F.periodoCot) * 864e5);
  const enP = r => { const f = parseFecha(col(r, P.fecha)); return !desde || !f || f >= desde; };
  const pSel = esJefe() ? F.punto : u().sede;
  const enPunto = r => !pSel || !col(r, P.bodega) || sedeCanon(col(r, P.bodega)) === pSel;
  const sin = d.sintesis.filter(r => enP(r) && enPunto(r)), crm = d.crm.filter(r => enP(r) && enPunto(r));
  const ixC = indexar(crm), ixS = indexar(sin);
  const telLeads = new Set(S.M.leads.map(l => l.tel).filter(Boolean));
  const res = sin.map(r => ({ r, en: buscar(ixC, r).length > 0, bot: telLeads.has(claves(r).tel) }));
  const soloCrm = crm.filter(r => !buscar(ixS, r).length);
  const sinClave = sin.filter(r => { const k = claves(r); return !k.ced && !k.tel && !k.mail; }).length;
  const asesores = uniq(res.map(x => String(col(x.r, P.asesor) || 'Sin asesor').trim()));
  const porAs = asesores.map(a => { const g = res.filter(x => String(col(x.r, P.asesor) || 'Sin asesor').trim() === a); return { a, n: g.length, en: g.filter(x => x.en).length, bot: g.filter(x => x.bot).length }; }).sort((x, y) => y.n - x.n);
  const pend = res.filter(x => !x.en);
  return head + tabs('cot', lista) + `<div class="filters"><select class="sel" data-mch="f" data-k="periodoCot">${opts([{ v: '30', t: 'Últimos 30 días' }, { v: '60', t: 'Últimos 60 días' }, { v: '90', t: 'Últimos 90 días' }, { v: 'todo', t: 'Todo' }], F.periodoCot)}</select>
      ${esJefe() ? `<select class="sel" data-mch="f" data-k="punto">${opts(['Itagüí', 'Los Colores'], F.punto, 'Todos los puntos')}</select>` : ''}</div>
    <div class="grid g-kpi">${kpi('En Síntesis', sin.length)}${kpi('En CRM', crm.length)}${kpi('En ambos', res.filter(x => x.en).length, fmtPct(pct(res.filter(x => x.en).length, sin.length)) + ' registradas en CRM', 'ok')}${kpi('Solo en Síntesis', pend.length, 'no están en el CRM', pend.length ? 'warn' : 'ok')}${kpi('Solo en CRM', soloCrm.length, 'sin cotización en Síntesis')}${kpi('Vinieron del bot', res.filter(x => x.bot).length, 'celular coincide con un lead')}</div>
    ${sinClave ? `<div class="notice" style="margin-top:10px"><i class="ti ti-alert-triangle"></i><div>${sinClave} cotización(es) de Síntesis no traen cédula, celular ni correo: no se pueden cruzar.</div></div>` : ''}
    <div class="section-title"><i class="ti ti-users"></i>Por asesor</div>
    ${porAs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Asesor</th><th class="r">Cotizaciones Síntesis</th><th class="r">Registradas en CRM</th><th class="r">%</th><th class="r">Del bot</th></tr></thead><tbody>${porAs.map(x => `<tr><td><b>${esc(x.a)}</b></td><td class="r num">${x.n}</td><td class="r num">${x.en}</td><td class="r num">${fmtPct(pct(x.en, x.n))}</td><td class="r num">${x.bot}</td></tr>`).join('')}</tbody></table></div>` : empty('ti-file-off', 'Sin cotizaciones de Síntesis en el período.')}
    <div class="section-title"><i class="ti ti-file-alert"></i>Solo en Síntesis (falta registrarlas en el CRM)<span class="count">${pend.length}</span></div>
    ${pend.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Cliente</th><th>Cédula</th><th>Celular</th><th>Asesor</th><th>Modelo</th></tr></thead><tbody>${pend.slice(0, 150).map(x => { const k = claves(x.r); return `<tr><td>${esc(fechaTxt(col(x.r, P.fecha)))}</td><td>${esc(col(x.r, P.nombre))}</td><td>${esc(k.ced)}</td><td>${esc(k.tel)}</td><td>${esc(col(x.r, P.asesor))}</td><td>${esc(col(x.r, P.modelo))}</td></tr>`; }).join('')}</tbody></table></div>` : empty('ti-circle-check', 'Todo lo de Síntesis está en el CRM.')}`;
}

// ═══════════════════════ CARGADOR DE EXPORTES (Síntesis/CRM) ══════════════
const DETECTA = {
  Inventario_Sistema: [['Modelo / artículo', P.modelo], ['Bodega / punto', P.bodega], ['Disponibilidad', P.cant], ['Días en inventario', P.dias]],
  Facturacion: [['Fecha', P.fecha], ['Modelo / artículo', P.modelo], ['Bodega / punto', P.bodega]],
  Ingresos_Taller: [['Fecha', P.fecha], ['Cédula', P.ced], ['Celular', P.tel], ['Correo', P.mail], ['Valor', P.valor]],
  Cotizaciones_Sintesis: [['Fecha', P.fecha], ['Cédula', P.ced], ['Celular', P.tel], ['Correo', P.mail], ['Asesor', P.asesor]],
  Cotizaciones_CRM: [['Fecha', P.fecha], ['Cédula', P.ced], ['Celular', P.tel], ['Correo', P.mail], ['Asesor', P.asesor]]
};
function importador(repo, hojas) {
  if (!IMP || IMP.repo !== repo) IMP = { repo, hoja: hojas[0][0], filas: null, lote: hoyTxt() };
  const det = IMP.filas ? (DETECTA[IMP.hoja] || []).map(([t, pats]) => [t, IMP.filas.some(r => String(col(r, pats) || '').trim() !== '')]) : [];
  const cols = IMP.filas ? uniq([].concat(...IMP.filas.slice(0, 50).map(r => Object.keys(r)))) : [];
  const cruce = ['Ingresos_Taller', 'Cotizaciones_Sintesis', 'Cotizaciones_CRM'].includes(IMP.hoja);
  const faltaClave = cruce && IMP.filas && !det.slice(1, 4).some(x => x[1]);
  return `<div class="card stack">
    <div class="grid g3"><div><label class="f">¿Qué vas a cargar?</label><select class="sel w100" data-mch="imp-hoja">${opts(hojas.map(([v, t]) => ({ v, t })), IMP.hoja)}</select></div>
      <div><label class="f">${IMP.hoja === 'Inventario_Sistema' ? 'Fecha del corte de inventario' : 'Fecha de la carga'}</label><input type="date" class="inp w100" data-mch="imp-lote" value="${IMP.lote}"></div>
      <div><label class="f">Archivo de Excel o CSV exportado</label><input type="file" class="inp w100" accept=".xlsx,.xls,.csv" data-mch="imp-file"></div></div>
    <details><summary class="small">…o pega aquí las celdas copiadas de Excel</summary><textarea class="inp" id="imp-txt" style="min-height:100px;font-family:monospace;font-size:.75rem;margin-top:6px"></textarea><button class="btn btn-sm" data-act="m-imp-leer" style="margin-top:6px">Leer lo pegado</button></details>
    ${IMP.filas ? `<div class="notice ${faltaClave ? 'bad' : 'ok'}"><i class="ti ti-${faltaClave ? 'alert-triangle' : 'circle-check'}"></i><div><b>${IMP.filas.length} filas leídas</b> · ${cols.length} columnas.<br>Detectado: ${det.map(([t, ok]) => `${ok ? '✓' : '✗'} ${t}`).join(' · ')}${faltaClave ? '<br>No hay cédula, celular ni correo: no se podrá cruzar.' : ''}</div></div>
      <div class="tbl-wrap" style="max-height:220px"><table class="tbl"><thead><tr>${cols.slice(0, 12).map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${IMP.filas.slice(0, 5).map(r => `<tr>${cols.slice(0, 12).map(c => `<td>${esc(/costo|serie/i.test(c) ? '•••' : r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="row between wrap"><span class="tiny muted">Se guardan todas las columnas tal como vienen. Si vuelves a subir filas iguales, se omiten.</span><button class="btn btn-primary" data-act="m-imp-subir"><i class="ti ti-upload"></i> Cargar ${IMP.filas.length} filas</button></div>` : ''}
  </div>`;
}
/** Convierte la hoja en objetos usando como encabezado la primera fila con 3+ celdas (los exportes traen títulos arriba). */
function filasDeMatriz(m) {
  const llenas = r => r.filter(c => String(c).trim() !== '').length;
  let h = m.findIndex((r, i) => llenas(r) >= 3 && m[i + 1] && llenas(m[i + 1]) >= 2);
  if (h < 0) h = 0;
  const hs = m[h].map(x => String(x).trim());
  return m.slice(h + 1).filter(r => llenas(r) > 0).map(r => { const o = {}; hs.forEach((k, i) => { if (k && !k.startsWith('_')) o[k] = r[i] === undefined ? '' : String(r[i]).trim(); }); return o; });
}
async function leerArchivo(input) {
  const f = input.files[0]; if (!f) return;
  try {
    await cargarScript(XLSX_URL);
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
    const m = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '', dateNF: 'yyyy-mm-dd' });
    IMP.filas = filasDeMatriz(m);
    if (IMP.hoja === 'Inventario_Sistema') { const fc = IMP.filas.map(r => fechaTxt(r.FECHACORTE || r.fechacorte || '')).find(Boolean); if (fc) IMP.lote = fc; }
    render();
  } catch (e) { toast('No se pudo leer el archivo: ' + e.message, 'bad'); }
}
async function subirImport(btn) {
  const filas = IMP.filas; if (!filas || !filas.length) return;
  btn.disabled = true;
  let agregadas = 0, repetidas = 0;
  try {
    for (let i = 0; i < filas.length; i += 1000) {
      btn.innerHTML = `<i class="ti ti-loader-2 spin"></i> ${Math.min(i + 1000, filas.length)}/${filas.length}`;
      const r = await api('importar', { repo: IMP.repo, hoja: IMP.hoja, lote: IMP.lote, filas: filas.slice(i, i + 1000), continuar: i > 0 });
      agregadas += r.agregadas; repetidas += r.repetidas;
    }
    toast(`${agregadas} filas cargadas${repetidas ? ` · ${repetidas} ya existían` : ''}`, 'ok');
    IMP.filas = null;
    await cargarMod(IMP.repo === 'posventa' ? 'posventa' : IMP.repo, true);
  } catch (e) { toast(e.message, 'bad'); btn.disabled = false; btn.textContent = 'Reintentar'; }
}

// ═══════════════════════════ AJUSTES → REPOSITORIOS ═════════════════════
async function cargarRepos() { try { REPOS = (await api('repos')).repos; } catch (e) { REPOS = { error: e.message }; } render(); }
function repoTab() {
  if (!REPOS) { cargarRepos(); return loading('Consultando repositorios…'); }
  if (REPOS.error) return `<div class="notice bad"><i class="ti ti-alert-triangle"></i><div>${esc(REPOS.error)}</div></div>`;
  const faltan = REPOS.filter(r => !r.existe).length;
  return `<div class="notice info" style="margin-bottom:12px"><i class="ti ti-info-circle"></i><div>Cada frente vive en su propio Google Sheet (se abre y descarga como Excel), para que ningún archivo se ponga pesado. El libro principal se queda con los Leads.
      <br><b>Financieras</b> y <b>Bonos</b> se crean como <b>copia</b>: el bot de n8n sigue leyendo las hojas originales hasta que se actualice; después se pueden borrar del libro principal.</div></div>
    ${faltan ? `<button class="btn btn-primary" data-act="m-repos-crear" style="margin-bottom:12px"><i class="ti ti-database-plus"></i> Crear ${faltan} repositorio(s) faltante(s)</button>` : '<div class="notice ok" style="margin-bottom:12px"><i class="ti ti-circle-check"></i><div>Todos los repositorios están creados.</div></div>'}
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Repositorio</th><th>Estado</th><th>Hojas</th><th>Vincular un archivo existente</th></tr></thead><tbody>
    ${REPOS.map(r => `<tr><td><b>${esc(r.nombre)}</b>${r.url ? `<br><a href="${esc(r.url)}" target="_blank" rel="noopener" class="small">Abrir archivo ↗</a>` : ''}</td>
      <td>${r.existe ? '<span class="pill pill-ok">Creado</span>' : r.configurado ? '<span class="pill pill-bad">Sin acceso</span>' : '<span class="pill pill-warn">Falta</span>'}</td>
      <td class="small" style="white-space:normal">${r.hojas.map(esc).join('<br>') || '—'}</td>
      <td><div class="row"><input class="inp" data-vinc-repo="${r.key}" placeholder="Enlace del Google Sheet" style="min-width:200px"><button class="btn btn-sm" data-act="m-repos-vincular" data-k="${r.key}">Vincular</button></div></td></tr>`).join('')}
    </tbody></table></div>`;
}

// ═════════════════════════════════ EVENTOS ═══════════════════════════════
async function onClick(act, el) {
  if (act === 'm-tab') { T[el.dataset.g] = el.dataset.v; return render(); }
  if (act === 'm-recargar') { D[el.dataset.m] = null; return cargarMod(el.dataset.m, true); }
  if (act === 'm-q') { const g = el.parentNode; $$('button', g).forEach(b => b.classList.toggle('on', b === el)); g.dataset.val = el.dataset.v; return; }
  if (act === 'm-step') { const i = $('#' + el.dataset.t); i.value = Math.max(0, (Number(i.value) || 0) + Number(el.dataset.d)); return; }
  if (act === 'm-daily') return formDaily(el.dataset.a);
  if (act === 'm-daily-guardar') return guardarDaily(el);
  if (act === 'm-check-guardar') return guardarCheck(el);
  if (act === 'm-comp-form') return formComp(el.dataset.a);
  if (act === 'm-comp-guardar') return guardarComp(el);
  if (act === 'm-comp-revisar') return formRevision(el.dataset.id);
  if (act === 'm-rev-guardar') return guardarRevision(el);
  if (act === 'm-excel') return excelSeguimiento();
  if (act === 'm-pos-nuevo') return formPosventa();
  if (act === 'm-pos-guardar') return guardarPosventa(el);
  if (act === 'm-pos-nota') return formNota(el.dataset.id);
  if (act === 'm-pos-nota-g') { const v = $('#pn-nota').value.trim(); cerrarSheet(); return actualizarPos(el.dataset.id, 'nota_gestion', v); }
  if (act === 'm-conteo') return formConteo(el.dataset.p);
  if (act === 'm-conteo-guardar') return guardarConteo(el);
  if (act === 'm-imp-leer') { const p = H.parsePegado($('#imp-txt').value); if (p.error) return toast(p.error, 'bad'); IMP.filas = p.rows; return render(); }
  if (act === 'm-imp-subir') return subirImport(el);
  if (act === 'm-ir-repos') { S.view = 'config'; S.cfgTab = 'repos'; H.renderNav(); return render(); }
  if (act === 'm-repos-crear') {
    if (!(await confirmar('Crear repositorios', 'Se crearán los archivos faltantes en el Google Drive de la cuenta dueña del script, con sus hojas y encabezados. Financieras y Bonos se copian del libro principal.', 'Crear'))) return;
    el.disabled = true; el.innerHTML = '<i class="ti ti-loader-2 spin"></i> Creando…';
    try { const r = await api('crearRepos'); REPOS = r.estado; Object.keys(D).forEach(k => { D[k] = null; }); toast(`${r.creados.length} repositorio(s) creado(s)`, 'ok'); H.cargar(true); render(); }
    catch (e) { toast(e.message, 'bad'); el.disabled = false; }
    return;
  }
  if (act === 'm-repos-vincular') {
    const v = $(`[data-vinc-repo="${el.dataset.k}"]`).value.trim(); if (!v) return toast('Pega el enlace del Google Sheet.', 'bad');
    try { const r = await api('vincularRepo', { key: el.dataset.k, id: v }); REPOS = r.estado; D[el.dataset.k] = null; toast('Repositorio vinculado', 'ok'); render(); } catch (e) { toast(e.message, 'bad'); }
  }
}
function onChange(t) {
  const k = t.dataset.mch;
  if (k === 'f') { F[t.dataset.k] = t.value; if (t.dataset.k === 'punto') F.asesor = ''; return render(); }
  if (k === 'pos-estado') return actualizarPos(t.dataset.id, 'estado', t.value);
  if (k === 'pos-fecha') return actualizarPos(t.dataset.id, 'fecha_proxima', t.value);
  if (k === 'imp-hoja') { IMP.hoja = t.value; IMP.filas = null; return render(); }
  if (k === 'imp-lote') { IMP.lote = t.value; return; }
  if (k === 'imp-file') return leerArchivo(t);
}

return {
  views: { seguimientos: vSeguimiento, posventa: vPosventa, inventario: vInventario, cotizaciones: vCotizaciones },
  onClick, onChange, repoTab,
  _test: { semanaKey, lunesDe, filasDeMatriz, claves, col }
};
};
