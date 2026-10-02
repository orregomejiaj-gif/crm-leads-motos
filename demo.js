/* Modo demo (?demo=1): backend falso en memoria con datos CLARAMENTE FICTICIOS.
 * No se conecta a ningún Sheet. Reproduce las reglas de permisos de backend/Code.gs
 * para poder revisar la app por rol sin tocar datos reales. */
(function () {
  'use strict';
  if (!/[?&]demo=1\b/.test(location.search)) return;

  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const pad = n => String(n).padStart(2, '0');
  const OFF = 5 * 3600e3;
  const fmtB = d => { const x = new Date(d.getTime() - OFF); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:00`; };
  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const sedeCanon = s => norm(s).includes('itag') ? 'Itagüí' : norm(s).includes('colores') ? 'Los Colores' : String(s || '');
  const now = new Date();
  const hace = h => new Date(now.getTime() - h * 3600e3);

  // Misma estructura que la hoja Equipo (cédulas ficticias).
  const IT = 'Punto Itagüí', LC = 'Punto Los Colores';
  const PERSONAL = [
    ['1000000001', 'DEMO Ana Asesora', 'ASESORA', IT, '3000000001', 'ventas'],
    ['1000000002', 'DEMO Beto Asesor', 'ASESOR', IT, '3000000002', 'ventas'],
    ['1000000003', 'DEMO Carla Asesora', 'ASESORA', LC, '3000000003', 'ventas'],
    ['1000000004', 'DEMO Darío Asesor', 'ASESOR', LC, '3000000003', 'ventas'],
    ['1000000005', 'DEMO Admin Itagüí', 'ADMINISTRADOR DE PUNTO', IT, '3000000005', 'ventas'],
    ['1000000006', 'DEMO Admin Colores', 'ADMINISTRADOR DE PUNTO', LC, '3000000006', 'ventas'],
    ['1000000007', 'DEMO Jefe Comercial', 'JEFE COMERCIAL', '', '3000000007', 'ventas'],
    ['1000000008', 'DEMO Técnico', 'ASESOR REPUESTOS, SERVICIO TECNICO Y ACCESORIOS', IT, '3000000008', 'posventa']
  ].map((r, i) => ({ _row: i + 2, CEDULA: r[0], nombre: r[1], cargo: r[2], nombre_punto: r[3], direccion: r[3] === IT ? 'Dirección demo 123' : '',
    zona_cobertura: '', whatsapp: r[4], correo: '', recibe: r[5], activo: 'Si' }));
  const ASESORES = PERSONAL.filter(p => /^ASESOR/.test(p.cargo) && p.recibe === 'ventas');
  const MODELOS = ['NKD 125', 'NKD 125 FP', 'CR4 150', 'CR4 125', 'Dynamic RX Fi', 'Jet Evo', 'TTR 200', 'CHR 125', 'Special 110 X'];
  const ZONAS = ['Itagüí centro', 'Envigado', 'Sabaneta', 'La Estrella', 'Belén', 'Laureles', 'Robledo', 'Calasanz'];
  const ORIGENES = ['Pauta Meta', 'Orgánico Instagram', 'Orgánico Facebook', 'Referido', 'TikTok'];
  const ANUNCIOS = ['DEMO Anuncio NKD octubre', 'DEMO Anuncio crédito fácil', 'DEMO Anuncio Dynamic', ''];
  const PAGOS = ['Contado', 'Crédito ProgreSER', 'Crédito', 'Por definir'];
  const MOTIVOS = ['precio', 'financiación negada', 'compró en otro lado', 'no contesta', 'otro'];

  const leads = [], gestion = [], cotizaciones = [], facturas = [], bitacora = [], alertas = [];
  // Horas desde asignación: algunos muy recientes para ver los semáforos de SLA.
  const edades = [0.3, 0.8, 1.4, 2.2, 3.5, 5, 7, 0.1, 26, 30].concat(Array.from({ length: 50 }, () => 10 + rnd() * 24 * 45));
  edades.forEach((h, i) => {
    const n = i + 1;
    const as = ASESORES[i % ASESORES.length];
    const asign = hace(h);
    const tieneTel = rnd() > 0.2;
    const id = 'DEMO-L' + pad(n).padStart(3, '0');
    const tel = tieneTel ? '57300' + String(1000000 + n * 7919).slice(-7) : '';
    const reciente = h < 8;
    const estado = reciente ? 'Nuevo' : h < 30 ? pick(['Nuevo', 'Contactado', 'Contactado']) : pick(['Contactado', 'Cotizado', 'Cotizado', 'Facturado', 'Facturado', 'Perdido', 'Perdido', 'Retenido']);
    const modelo = rnd() > 0.1 ? pick(MODELOS) : '';
    const cita = rnd() > 0.85 ? fmtB(now).slice(0, 10) : rnd() > 0.85 ? fmtB(hace(-48)).slice(0, 10) : '';
    const L = {
      _row: n + 1, id_lead: id, nombre_completo: rnd() > 0.1 ? `Cliente Demo ${pad(n)}` : '', telefono_whatsapp: tel, fecha_primer_contacto: fmtB(hace(h + 0.2)),
      marca: 'DEMO', ctwa_clid: '', anuncio_origen: pick(ANUNCIOS), modelo_interes: modelo, zona: rnd() > 0.15 ? pick(ZONAS) : '',
      intencion_compra: pick(['Este mes', 'Próximos 3 meses', 'Solo averiguando', '']), moto_entrega: pick(['No', 'Sí', '']), forma_pago: rnd() > 0.2 ? pick(PAGOS) : '',
      cuota_aprox: '', etiqueta: pick(['caliente', 'tibio', 'frío', '']), etapa: '', producto_cotizado: '', punto_asignado: as.nombre_punto,
      nombre_asesor: as.nombre, asesor_whatsapp: as.whatsapp, direccion_punto: '', cita_dia: cita, cita_hora: cita ? pick(['10:00', '11:30', '3:00 p. m.', '16:30']) : '',
      fecha_asignacion: fmtB(asign), cliente_respuesta_satisfaccion: !reciente && rnd() > 0.6 ? String(Math.floor(rnd() * 5) + 6) : '',
      resultado_venta: '', tipo_consulta: 'Compra moto', origen: pick(ORIGENES), comentario_cliente: '', fecha_cierre: '',
      id_contacto: tieneTel ? tel : 'BSUID-DEMO-' + n, bsuid: 'BSUID-DEMO-' + n, username_whatsapp: 'usuario_demo_' + pad(n), tiene_telefono: tieneTel ? 'Sí' : 'No',
      memoria_resumen: `[DEMO] Cliente interesado en ${modelo || 'una moto'}; pregunta por ${pick(['cuota inicial', 'precio de contado', 'colores disponibles', 'requisitos del crédito'])}. Prefiere que lo llamen en la tarde.`,
      etiqueta_asesor: rnd() > 0.5 ? pick(['caliente', 'tibio', 'frío']) : '', ultimo_mensaje_id: '', fecha_ultimo_mensaje: fmtB(hace(Math.max(0, h - 1)))
    };
    leads.push(L);
    if (i === 3) return; // un lead sin fila de gestión (n8n aún no la crea)
    const g = {
      _row: gestion.length + 2, id_lead: id, fecha_hora_registro: fmtB(asign), telefono_whatsapp: tel, nombre_cliente: L.nombre_completo, zona: L.zona,
      modelo_interes: modelo, punto_asignado: L.punto_asignado, nombre_asesor: as.nombre, origen_evento: L.origen,
      contactado: estado !== 'Nuevo' ? 'Sí' : '', respuesta_cliente: estado !== 'Nuevo' && rnd() > 0.5 ? pick(['Contestó, pide cotización', 'Pide que lo llamen mañana', 'Interesado']) : '',
      cotizado: ['Cotizado', 'Facturado'].includes(estado) ? 'Sí' : '', resultado: estado === 'Facturado' ? 'ganado' : estado === 'Perdido' ? 'perdido' : estado === 'Retenido' ? 'retenido' : '',
      motivo_perdida: estado === 'Perdido' ? pick(MOTIVOS) : '', fecha_ultima_actualizacion: fmtB(hace(Math.max(0, h - 5 - rnd() * 40))), negocio_creado: ''
    };
    gestion.push(g);
    if (g.contactado) bitacora.push({ fecha_hora: fmtB(new Date(asign.getTime() + (rnd() > 0.35 ? 0.4 : 3) * 3600e3)), usuario: 'demo', rol: 'asesor', hoja: 'Gestion_Asesor', llave: id, campo: 'contactado', valor_anterior: '', valor_nuevo: 'Sí', origen: 'app' });
    if (g.cotizado && !(i % 11 === 0)) cotizaciones.push({ _row: cotizaciones.length + 2, id_cotizacion: 'DEMO-COT-' + n, fecha: fmtB(hace(h - 3)), telefono_lead: tel, id_contacto: L.id_contacto, nombre_cliente: L.nombre_completo, sede: L.punto_asignado, asesor: as.nombre, modelo: modelo || 'NKD 125', precio_cotizado: 5490000 + Math.floor(rnd() * 6) * 500000, forma_pago: L.forma_pago, estado_cotizacion: 'Enviada', observaciones: '' });
    if (estado === 'Facturado' && i % 7 !== 0) facturas.push({ _row: facturas.length + 2, id_factura: 'DEMO-FAC-' + n, id_lead: id, fecha: fmtB(hace(Math.max(1, h - 30))), modelo: modelo || 'NKD 125', valor: 5000000 + Math.floor(rnd() * 8) * 600000, asesor: as.nombre, sede: L.punto_asignado, telefono_cliente: tel, observaciones: '' });
    if (estado === 'Nuevo' && h > 3) alertas.push({ _row: alertas.length + 2, id_alerta: 'DEMO-AL-' + n, fecha_hora: fmtB(hace(h - 3)), id_contacto: L.id_contacto, id_lead: id, tipo: 'sla_vencido', nivel: 'vencida', destinatario: as.nombre + ', Jefe', canal: 'whatsapp', mensaje: '[DEMO] Lead sin contacto 3 h', atendida: '', fecha_atendida: '' });
  });
  cotizaciones.push({ _row: cotizaciones.length + 2, id_cotizacion: 'DEMO-COT-H1', fecha: fmtB(hace(50)), telefono_lead: '3009999991', nombre_cliente: 'Cliente Demo Huérfano', sede: 'Punto Itagüí', asesor: 'DEMO Ana Asesora', modelo: 'CR4 150', precio_cotizado: 6990000, forma_pago: 'Contado', estado_cotizacion: 'Enviada', observaciones: '' });
  facturas.push({ _row: facturas.length + 2, id_factura: 'DEMO-FAC-X1', id_lead: '', fecha: fmtB(hace(70)), modelo: 'Jet Evo', valor: 12590000, asesor: 'DEMO Carla Asesora', sede: 'Punto Los Colores', telefono_cliente: '3009999992', observaciones: 'Venta de vitrina (demo)' });

  const mes = fmtB(now).slice(0, 7);
  const metas = ASESORES.map((a, i) => ({ _row: i + 2, persona: a.nombre, sede: a.nombre_punto, mes, meta_motos: 10, rol: 'asesor' }));
  const seguimientos = [{
    _row: 2, id_seguimiento: 'SEG-DEMO-1', fecha: fmtB(hace(24 * 20)), tipo: 'Asesor', sede: IT, evaluado: 'DEMO Ana Asesora', evaluador: 'DEMO Jefe Comercial',
    periodo: fmtB(hace(24 * 20)).slice(0, 7), calificacion: 7, indicadores_json: JSON.stringify({ asignados: { titulo: 'Leads asignados', valor: 18 }, contacto: { titulo: 'Contactados ≤ 1 h hábil', valor: '61%' } }),
    evaluacion_json: JSON.stringify({ items: { atencion: 3, producto: 4, financiacion: 3, objeciones: 3, cierre: 2, registro: 3, presentacion: 5 }, indicadores_eval: { contacto: { evaluacion: 'Requiere mejora', observacion: 'Responder antes de 1 h' } } }),
    fortalezas: '[DEMO] Buen conocimiento del portafolio.', oportunidades: '[DEMO] Cerrar cotizaciones con fecha de seguimiento.',
    compromisos_json: JSON.stringify([{ accion: 'Contactar todos los leads nuevos en menos de 1 h hábil', responsable: 'DEMO Ana Asesora', fecha: fmtB(hace(24 * 5)).slice(0, 10), cumplido: false }]),
    observaciones: '', proximo_seguimiento: fmtB(hace(-24 * 5)).slice(0, 10)
  }];

  const DB = {
    Leads: leads, Gestion_Asesor: gestion, Cotizaciones: cotizaciones, Facturas: facturas, Metas: metas, Estados: [],
    Alertas_Log: alertas, Equipo: PERSONAL, Sedes: [
      { _row: 2, nombre_punto: 'Punto Itagüí', marca: 'DEMO', direccion: 'Dirección demo 123', zona_cobertura: 'Itagüí y alrededores', nombre_asesor: '', asesor_whatsapp: '' },
      { _row: 3, nombre_punto: 'Punto Los Colores', marca: 'DEMO', direccion: '', zona_cobertura: 'Medellín, Los Colores', nombre_asesor: '', asesor_whatsapp: '' }],
    Inventarios: MODELOS.map(m => ({ modelo: m, categoria: '', disponible_itagui: Math.floor(rnd() * 5) || '', disponible_los_colores: '' })),
    Bitacora_App: bitacora, Config_App: [], Seguimientos: seguimientos
  };
  const headers = n => n === 'Inventarios' ? ['marca', 'modelo', 'categoria', 'precio_publico', 'precio_promocional_medio_pago', 'bono', 'disponible_itagui', 'disponible_los_colores', 'fuente']
    : Object.keys(DB[n][0] || {}).filter(k => k !== '_row');
  const SOLICITUDES = {
    Facturas: ['id_factura', 'id_lead', 'fecha', 'modelo', 'valor', 'asesor', 'sede', 'telefono_cliente', 'observaciones'],
    Metas: ['persona', 'sede', 'mes', 'meta_motos', 'rol'], Estados: ['estado', 'orden', 'siguientes', 'requiere_evidencia', 'activo'],
    Alertas_Log: ['id_alerta', 'fecha_hora', 'id_contacto', 'id_lead', 'tipo', 'nivel', 'destinatario', 'canal', 'mensaje', 'atendida', 'fecha_atendida'],
    Bitacora_App: ['fecha_hora', 'usuario', 'rol', 'hoja', 'llave', 'campo', 'valor_anterior', 'valor_nuevo', 'origen'],
    Config_App: ['clave', 'valor', 'descripcion', 'actualizado_por', 'fecha'],
    Seguimientos: ['id_seguimiento', 'fecha', 'tipo', 'sede', 'evaluado', 'evaluador', 'evaluador_correo', 'periodo', 'calificacion', 'indicadores_json', 'evaluacion_json', 'fortalezas', 'oportunidades', 'compromisos_json', 'observaciones', 'proximo_seguimiento']
  };
  const HEADERS = {};
  Object.keys(DB).forEach(n => { HEADERS[n] = SOLICITUDES[n] || headers(n); });
  HEADERS.Historial_Chats = ['fecha_hora', 'telefono_whatsapp', 'nombre_completo', 'remitente', 'mensaje', 'etiqueta'];

  const ROLES = [
    { id: 'jefe', label: 'DEMO · Jefe Comercial', user: { usuario: 'DEMO Jefe Comercial', nombre: 'DEMO Jefe Comercial', rol: 'jefe', sede: '' } },
    { id: 'admin', label: 'DEMO · Admin Itagüí', user: { usuario: 'DEMO Admin Itagüí', nombre: 'DEMO Admin Itagüí', rol: 'admin', sede: 'Itagüí' } },
    { id: 'asesor', label: 'DEMO · Ana (asesora)', user: { usuario: 'DEMO Ana Asesora', nombre: 'DEMO Ana Asesora', rol: 'asesor', sede: 'Itagüí' } },
    { id: 'asesor2', label: 'DEMO · Carla (asesora)', user: { usuario: 'DEMO Carla Asesora', nombre: 'DEMO Carla Asesora', rol: 'asesor', sede: 'Los Colores' } }
  ];
  const NIVEL = { asesor: 1, admin: 2, jefe: 3 };
  const EDITABLE = {
    Gestion_Asesor: { contactado: 'asesor', respuesta_cliente: 'asesor', cotizado: 'asesor', resultado: 'asesor', motivo_perdida: 'asesor', nombre_asesor: 'admin' },
    Leads: { etiqueta_asesor: 'asesor', nombre_asesor: 'admin' }
  };
  const clone = o => JSON.parse(JSON.stringify(o));
  const fail = (m, c) => { const e = new Error(m); e.code = c; throw e; };
  const puedeVer = (u, l) => u.rol === 'jefe' || (u.rol === 'admin' ? sedeCanon(l.punto_asignado) === u.sede : norm(l.nombre_asesor) === norm(u.nombre));

  function handle(action, p, rolId) {
    const u = (ROLES.find(r => r.id === rolId) || ROLES[0]).user;
    return new Promise((res, rej) => setTimeout(() => {
      try { res(clone(run(action, p, u))); } catch (e) { rej(e); }
    }, 180));
  }

  function run(action, p, u) {
    const esJefe = u.rol === 'jefe', esAdmin = u.rol === 'admin';
    if (action === 'bootstrap') {
      const vis = DB.Leads.filter(l => puedeVer(u, l));
      const ids = new Set(vis.map(l => l.id_lead));
      const mismaSede = s => esJefe || sedeCanon(s) === u.sede;
      return {
        ok: true, version: 'demo', serverTime: fmtB(new Date()), user: u, hojas: HEADERS, solicitudes: SOLICITUDES,
        leads: vis, gestion: DB.Gestion_Asesor.filter(g => ids.has(g.id_lead)),
        cotizaciones: esJefe || esAdmin ? DB.Cotizaciones.filter(c => mismaSede(c.sede)) : DB.Cotizaciones.filter(c => norm(c.asesor) === norm(u.nombre)),
        facturas: esJefe || esAdmin ? DB.Facturas.filter(f => mismaSede(f.sede)) : DB.Facturas.filter(f => ids.has(f.id_lead)),
        alertas: DB.Alertas_Log.filter(a => esJefe || ids.has(a.id_lead)),
        bitacora: DB.Bitacora_App.filter(b => esJefe || ids.has(b.llave)),
        metas: DB.Metas.filter(m => esJefe || esAdmin ? mismaSede(m.sede) : norm(m.persona) === norm(u.nombre)),
        estados: DB.Estados,
        personal: DB.Equipo.filter(x => esJefe || mismaSede(x.nombre_punto)).map(x => { const o = esJefe ? Object.assign({}, x) : { _row: x._row, nombre: x.nombre, cargo: x.cargo, nombre_punto: x.nombre_punto, recibe: x.recibe, activo: x.activo, whatsapp: esAdmin ? x.whatsapp : '' }; o.sede = x.nombre_punto; o.sedeCanon = sedeCanon(x.nombre_punto); return o; }),
        sedes: DB.Sedes, inventario: DB.Inventarios, config: DB.Config_App,
        seguimientos: DB.Seguimientos.filter(s => esJefe || (esAdmin ? sedeCanon(s.sede) === u.sede : norm(s.evaluado) === norm(u.nombre)))
      };
    }
    if (action === 'chats') {
      const l = DB.Leads.find(x => x.id_lead === p.id_lead);
      if (!l || !puedeVer(u, l)) fail('No tienes acceso a este lead.', 'FORBIDDEN');
      const t0 = Date.parse(l.fecha_primer_contacto + 'Z') + OFF; // hora Colombia → instante real
      const m = (min, r, txt) => ({ fecha_hora: fmtB(new Date(t0 + min * 6e4)), telefono_whatsapp: l.telefono_whatsapp, nombre_completo: l.nombre_completo, remitente: r, mensaje: txt });
      return { ok: true, mensajes: [
        m(0, 'cliente', 'Hola, info de la ' + (l.modelo_interes || 'moto') + ' (mensaje demo)'),
        m(1, 'bot', '¡Hola! Soy el asistente virtual del punto de venta. ¿La quieres de contado o a crédito? (demo)'),
        m(3, 'cliente', l.forma_pago || 'Todavía no sé'),
        m(4, 'bot', 'Perfecto. Te asigno a ' + l.nombre_asesor + ' del punto ' + sedeCanon(l.punto_asignado) + '. (demo)')
      ] };
    }
    if (action === 'update') {
      const f = (EDITABLE[p.sheet] || {})[p.field];
      if (!f) fail('La app no puede editar ' + p.sheet + '.' + p.field, 'FORBIDDEN');
      if (NIVEL[u.rol] < NIVEL[f]) fail('Tu rol no permite cambiar ' + p.field + '.', 'FORBIDDEN');
      const l = DB.Leads.find(x => x.id_lead === p.key || (!x.id_lead && x.id_contacto === p.key));
      if (!l || !puedeVer(u, l)) fail('No tienes acceso a este lead.', 'FORBIDDEN');
      const row = p.sheet === 'Leads' ? l : DB.Gestion_Asesor.find(g => g.id_lead === l.id_lead);
      if (!row) fail('n8n aún no creó la fila de gestión de este lead.', 'NOROW');
      const actual = String(row[p.field] ?? '');
      if (p.expected !== undefined && p.expected !== null && String(p.expected) !== actual) return { ok: false, conflict: true, actual, error: 'Otra persona cambió este dato.' };
      if (actual === String(p.value)) return { ok: true, sinCambio: true };
      row[p.field] = String(p.value);
      const fecha = fmtB(new Date());
      if (p.sheet === 'Gestion_Asesor') row.fecha_ultima_actualizacion = fecha;
      DB.Bitacora_App.push({ fecha_hora: fecha, usuario: u.usuario, rol: u.rol, hoja: p.sheet, llave: p.key, campo: p.field, valor_anterior: actual, valor_nuevo: String(p.value), origen: 'app' });
      return { ok: true, valor: p.value, fecha };
    }
    if (action === 'seguimiento') {
      if (u.rol === 'asesor') fail('Solo el Jefe Comercial o el Administrador registran seguimientos.', 'FORBIDDEN');
      const s = p.seguimiento;
      DB.Seguimientos.push({ _row: DB.Seguimientos.length + 2, id_seguimiento: 'SEG-DEMO-' + (DB.Seguimientos.length + 1), fecha: fmtB(new Date()), tipo: s.tipo, sede: s.sede, evaluado: s.evaluado,
        evaluador: u.nombre, periodo: s.periodo, calificacion: s.calificacion, indicadores_json: JSON.stringify(s.indicadores), evaluacion_json: JSON.stringify(s.evaluacion),
        fortalezas: s.fortalezas, oportunidades: s.oportunidades, compromisos_json: JSON.stringify(s.compromisos), observaciones: s.observaciones, proximo_seguimiento: s.proximo_seguimiento });
      return { ok: true };
    }
    if (action === 'config') {
      if (!esJefe) fail('Solo el Jefe Comercial cambia la configuración.', 'FORBIDDEN');
      Object.entries(p.valores).forEach(([k, v]) => {
        const r = DB.Config_App.find(x => x.clave === k);
        if (r) r.valor = v; else DB.Config_App.push({ _row: DB.Config_App.length + 2, clave: k, valor: v });
      });
      return { ok: true };
    }
    if (action === 'append') {
      if (!esJefe) fail('Solo el Jefe Comercial carga datos.', 'FORBIDDEN');
      const key = { Cotizaciones: 'id_cotizacion', Facturas: 'id_factura', Metas: null }[p.sheet];
      const rep = [];
      let n = 0;
      p.rows.forEach(r => {
        if (key && DB[p.sheet].some(x => String(x[key]) === String(r[key]))) { rep.push(r[key]); return; }
        DB[p.sheet].push(Object.assign({ _row: DB[p.sheet].length + 2 }, r)); n++;
      });
      return { ok: true, agregadas: n, repetidas: rep };
    }
    if (action === 'adminUpdate') {
      if (!esJefe) fail('Solo el Jefe Comercial edita ' + p.sheet + '.', 'FORBIDDEN');
      const r = (DB[p.sheet] || []).find(x => x._row === p.row);
      if (!r) fail('Fila inválida.', 'INVALID');
      if (p.expected !== undefined && String(r[p.field] ?? '') !== String(p.expected)) return { ok: false, conflict: true, error: 'Este dato cambió mientras lo editabas.' };
      r[p.field] = p.value;
      return { ok: true };
    }
    fail('Acción no reconocida: ' + action);
  }

  window.AKT_DEMO = { handle, roles: ROLES };
})();
