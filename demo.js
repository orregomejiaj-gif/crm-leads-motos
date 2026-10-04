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
  const DEMO_CHAT = {}; // chats del asesor en modo demo (solo en memoria)
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
  // ── Repositorios de la etapa 2 (también ficticios) ──
  const ymdB = d => fmtB(d).slice(0, 10);
  const semK = d => { const x = new Date(Date.UTC(+ymdB(d).slice(0, 4), +ymdB(d).slice(5, 7) - 1, +ymdB(d).slice(8, 10))); const dw = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dw + 3); const j4 = new Date(Date.UTC(x.getUTCFullYear(), 0, 4)); return x.getUTCFullYear() + '-W' + pad(1 + Math.round(((x - j4) / 864e5 - 3 + ((j4.getUTCDay() + 6) % 7)) / 7)); };
  const pc = a => a.nombre_punto === IT ? 'Itagüí' : 'Los Colores';
  const daily = [], checklist = [], compromisos = [];
  for (let i = 1; i <= 28; i++) {
    const d = hace(24 * i); if (new Date(d.getTime() - OFF).getUTCDay() === 0) continue;
    ASESORES.forEach(a => { if (rnd() < 0.15) return; daily.push({ id: 'DAI-D' + i + a.CEDULA, fecha: ymdB(d), registrado_por: 'DEMO Jefe Comercial', punto: pc(a), asesor: a.nombre,
      leads_asignados_crm: Math.floor(rnd() * 4), contactados_crm: Math.floor(rnd() * 4), sin_contacto_crm: Math.floor(rnd() * 2), gestion_leads: pick(['Sí', 'Sí', 'Parcial', 'No']),
      contactos: 4 + Math.floor(rnd() * 14), citas: Math.floor(rnd() * 4), cotizaciones: Math.floor(rnd() * 5), ventas: rnd() < 0.3 ? 1 : 0, semaforo: pick(['Verde', 'Verde', 'Amarillo', 'Rojo']), bloqueo: rnd() < 0.15 ? '[DEMO] Cliente espera aprobación de crédito' : '' }); });
  }
  const CK = ['Leads de la semana gestionados en el CRM (sin SLA vencidos abiertos)', 'Cotizaciones abiertas con seguimiento registrado', 'Facturas de la semana cargadas en el CRM', 'Inventario del punto revisado contra el sistema', 'Modelos básicos (los más vendidos) disponibles en exhibición', 'Exhibición ordenada, precios y bonos visibles', 'Solicitudes de crédito en trámite revisadas con las financieras', 'Interesados de posventa contactados', 'Metas de la semana socializadas con el equipo', 'Compromisos de la semana anterior revisados con cada asesor'];
  for (let w = 1; w <= 5; w++) ['Itagüí', 'Los Colores'].forEach(p => { const its = CK.map(item => ({ item, ok: rnd() < 0.7, nota: '' })); const c = its.filter(x => x.ok).length;
    checklist.push({ id: 'CHE-' + w + p, semana: semK(hace(24 * 7 * w)), registrado_por: 'DEMO Jefe Comercial', punto: p, items_json: JSON.stringify(its), cumplidos: c, total: its.length, porcentaje: Math.round(c / its.length * 100), observaciones: '' }); });
  for (let w = 0; w <= 3; w++) ASESORES.forEach(a => { if (w === 0 && rnd() < 0.5) return; const est = w === 0 ? '' : pick(['cumplido', 'parcial', 'no', 'cumplido']);
    compromisos.push({ id: 'COM-' + w + a.CEDULA, semana: semK(hace(24 * 7 * w)), registrado_por: a.nombre, asesor: a.nombre, punto: pc(a), meta_motos: 2 + Math.floor(rnd() * 3), meta_citas: 5, meta_cotizaciones: 8,
      accion_1: '[DEMO] Llamar a los cotizados de la semana anterior', accion_2: '[DEMO] Publicar 3 historias de modelos en stock', accion_3: '', revision_estado: est, revision_motos_reales: est ? Math.floor(rnd() * 4) : '', revision_nota: '', revisado_por: est ? 'DEMO Jefe Comercial' : '' }); });
  const TIPOS = ['Accesorios', 'Repuestos', 'Revisión / mantenimiento', 'Garantía'];
  const interesados = Array.from({ length: 30 }, (_, i) => ({ id: 'INT-D' + i, registrado: fmtB(hace(24 * (1 + rnd() * 40))), registrado_por: pick(['DEMO Técnico', 'DEMO Ana Asesora', 'DEMO Carla Asesora']), punto: rnd() < 0.6 ? 'Itagüí' : 'Los Colores',
    nombre: 'Cliente Posventa Demo ' + pad(i + 1), cedula: rnd() < 0.6 ? String(9000000 + i) : '', celular: '3101000' + pad(i + 10), correo: '', tipo: pick(TIPOS), detalle: pick(['[DEMO] Casco talla M', '[DEMO] Kit de arrastre', '[DEMO] Revisión de 5.000 km', '[DEMO] Llantas traseras']),
    moto_cliente: pick(MODELOS), origen: pick(['Punto de venta', 'WhatsApp', 'Llamada']), estado: pick(['Nuevo', 'Contactado', 'Agendado', 'Ingresó / compró', 'Sin interés']), proxima_accion: '', fecha_proxima: rnd() < 0.4 ? ymdB(hace(24 * (rnd() * 10 - 5))) : '', nota_gestion: '' }));
  const ingresos = Array.from({ length: 14 }, (_, i) => ({ _lote: ymdB(hace(24)), 'Fecha orden': ymdB(hace(24 * (rnd() * 20))), 'Cliente': i < 9 ? interesados[i * 3].nombre : 'Cliente Taller Demo ' + i,
    'Cedula cliente': i < 9 ? interesados[i * 3].cedula : String(8000000 + i), 'Telefono': i < 9 ? interesados[i * 3].celular : '3209000' + pad(i), 'Tipo trabajo': pick(['Revisión', 'Repuestos', 'Accesorios']), 'Valor total': 80000 + Math.floor(rnd() * 20) * 15000 }));
  const motosIt = [], motosLc = [];
  [['MOTOS  ITAGUI', motosIt], ['MOTOS MEDELLIN', motosLc]].forEach(([bod, arr]) => MODELOS.forEach(m => { const n = Math.floor(rnd() * 4); for (let k = 0; k < n; k++) arr.push({ _lote: ymdB(hace(48)), articulo: m, presentacion: 'MOD 2027 ; ' + pick(['NEGRO', 'GRIS', 'AZUL', 'BLANCO']), bodega: bod, disponibilidad: 1, DIASINVENTARIO: Math.floor(rnd() * 220), FECHACORTE: ymdB(hace(48)), costo: 1, serie: 'X' }); }));
  const REPS = ['Kit de arrastre NKD', 'Pastillas freno delanteras', 'Filtro de aceite 125', 'Casco integral talla M', 'Guantes MC29', 'Llanta trasera 90/90-17', 'Bujía CR7HSA', 'Espejo retrovisor izq.', 'Cadena 428H', 'Aceite 20W50 1L'];
  const repIt = REPS.map((a, i) => ({ _lote: ymdB(hace(24)), codigo: '77010' + (1000 + i), articulo: '[DEMO] ' + a, presentacion: 'UND', bodega: 'REPUESTOS ITAGUI', disponibilidad: Math.floor(rnd() * 15), DIASINVENTARIO: Math.floor(rnd() * 120), FECHACORTE: ymdB(hace(24)) }));
  const repLc = REPS.slice(2).map((a, i) => ({ _lote: ymdB(hace(24)), codigo: '77010' + (1000 + i), articulo: '[DEMO] ' + a, presentacion: 'UND', bodega: 'REPUESTOS MEDELLIN', disponibilidad: Math.floor(rnd() * 10), DIASINVENTARIO: Math.floor(rnd() * 120), FECHACORTE: ymdB(hace(24)) }));
  const pendiente = [['NKD 125', 4, 'Itagüí', 5], ['CR4 150', 2, 'Los Colores', -3], ['TTR 200', 3, 'Itagüí', 12]].map(([m, c, p, d], i) => ({ id: 'PEN-D' + i, registrado: fmtB(hace(72)), registrado_por: 'DEMO Jefe Comercial',
    marca: 'DEMO', modelo: m, color_variante: pick(['NEGRO', 'GRIS']), cantidad_pendiente: c, fecha_estimada_llegada: ymdB(hace(-24 * d)), factura_orden_compra: 'OC-DEMO-' + (100 + i), bodega_destino: p, observaciones: '', estado: 'Pendiente' }));
  const sistema = motosIt.concat(motosLc);
  const facturacion = Array.from({ length: 70 }, (_, i) => ({ _lote: ymdB(hace(24)), Fecha: ymdB(hace(24 * rnd() * 90)), Articulo: pick(MODELOS.slice(0, 5).concat(MODELOS)), Bodega: rnd() < 0.55 ? 'MOTOS  ITAGUI' : 'MOTOS LOS COLORES', Cantidad: 1, Cliente: 'Comprador Demo ' + i, Valor: 6000000 + Math.floor(rnd() * 10) * 500000 }));
  const conteos = MODELOS.slice(0, 6).map((m, i) => { const s = motosIt.filter(x => x.articulo === m).length; const f = i === 2 ? Math.max(0, s - 1) : i === 4 ? s + 1 : s;
    return { id: 'CON-D' + i, fecha: ymdB(hace(24 * 6)), registrado_por: 'DEMO Admin Itagüí', punto: 'Itagüí', modelo: m, cantidad_sistema: s, cantidad_fisica: f, diferencia: f - s, observacion: f !== s ? '[DEMO] revisar traslado' : '' }; });
  const telLead = leads.map(l => l.telefono_whatsapp).filter(Boolean);
  const cotSin = Array.from({ length: 40 }, (_, i) => ({ _lote: ymdB(hace(24)), 'Fecha': ymdB(hace(24 * rnd() * 70)), 'Nit/Cedula': String(7000000 + i), 'Nombre cliente': 'Cotizado Demo ' + pad(i), 'Celular': i % 3 === 0 && telLead[i] ? telLead[i] : '3155' + pad(100000 + i).slice(-6), 'Vendedor': pick(ASESORES).nombre, 'Articulo': pick(MODELOS), 'Bodega': rnd() < 0.5 ? 'MOTOS  ITAGUI' : 'MOTOS LOS COLORES', 'Valor': 7000000 }));
  const cotCrm = cotSin.filter(() => rnd() < 0.65).map(r => ({ _lote: ymdB(hace(24)), fecha_creacion: r.Fecha, documento: r['Nit/Cedula'], cliente: r['Nombre cliente'], telefono: r.Celular, asesor: r.Vendedor }))
    .concat(Array.from({ length: 5 }, (_, i) => ({ _lote: ymdB(hace(24)), fecha_creacion: ymdB(hace(24 * i)), documento: String(6000000 + i), cliente: 'Solo CRM Demo ' + i, telefono: '3177' + pad(100000 + i).slice(-6), asesor: pick(ASESORES).nombre })));
  const FINS_D = ['Progresar (ProgreSER)', 'Sufi (Bancolombia)', 'Addi', 'Banco de Bogotá'];
  const CIUD_D = ['Itagüí', 'Envigado', 'Sabaneta', 'Medellín', 'Bello', 'La Estrella'];
  const simulaciones = Array.from({ length: 26 }, (_, i) => { const m = pick(MODELOS), v = 5490000 + Math.floor(rnd() * 12) * 500000, ini = Math.floor(rnd() * 4) * 500000, c = pick(CIUD_D), comp = rnd() < 0.55;
    return { id: 'sim_demo_' + i, fecha: fmtB(hace(24 * rnd() * 25)), nombre: 'Cotizador Demo ' + pad(i), celular: '57315' + pad(1000000 + i).slice(-7), email: i % 2 ? 'demo' + i + '@correo.com' : '',
      modelo: m, categoria: 'Calle', valor_moto: v, cuota_inicial: ini, monto_financiar: v - ini, plazo_meses: pick([24, 36, 48]), ciudad: c, financiador: pick(FINS_D),
      cuota_mensual_estim: Math.round((v - ini) / 30), completado: comp ? 'SI' : 'NO', fuente: rnd() < 0.35 ? 'cotizador_whatsapp' : 'cotizador_web',
      punto_sugerido: /itag|envigad|sabanet|estrella/i.test(c.normalize('NFD').replace(/[\u0300-\u036f]/g, '')) ? 'Itagüí' : 'Los Colores', id_lead: 'L-DEMO-SIM-' + i }; });
  const REPO = { seguimientos: { daily, checklist, compromisos }, posventa: { interesados, ingresos }, inventario: { motosIt, motosLc, repIt, repLc, pendiente, facturacion, conteos }, cotizaciones: { sintesis: cotSin, crm: cotCrm, simulaciones } };
  const REPO_HOJA = { Daily_Asesor: ['seguimientos', 'daily'], Checklist_Semanal: ['seguimientos', 'checklist'], Compromisos_Semana: ['seguimientos', 'compromisos'], Interesados: ['posventa', 'interesados'],
    Ingresos_Taller: ['posventa', 'ingresos'], Motos_Itagui: ['inventario', 'motosIt'], Motos_Los_Colores: ['inventario', 'motosLc'], Repuestos_Itagui: ['inventario', 'repIt'],
    Repuestos_Los_Colores: ['inventario', 'repLc'], Pendiente_por_Llegar: ['inventario', 'pendiente'], Facturacion: ['inventario', 'facturacion'], Conteo_Fisico: ['inventario', 'conteos'], Cotizaciones_Sintesis: ['cotizaciones', 'sintesis'], Cotizaciones_CRM: ['cotizaciones', 'crm'] };

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
    { id: 'asesor2', label: 'DEMO · Carla (asesora)', user: { usuario: 'DEMO Carla Asesora', nombre: 'DEMO Carla Asesora', rol: 'asesor', sede: 'Los Colores' } },
    { id: 'posventa', label: 'DEMO · Técnico (posventa)', user: { usuario: 'DEMO Técnico', nombre: 'DEMO Técnico', rol: 'asesor', sede: 'Itagüí', recibe: 'posventa' } }
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
        repos: { seguimientos: true, posventa: true, cotizaciones: true, inventario: true, financieras: true, bonos: true },
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
      const k = l.id_lead, extra = (DEMO_CHAT[k] = DEMO_CHAT[k] || { estado: l.nombre_asesor ? 'asesor' : 'bot', msgs: [] });
      const ahoraD = Date.now();
      return { ok: true, mensajes: [
        m(0, 'cliente', 'Hola, info de la ' + (l.modelo_interes || 'moto') + ' (mensaje demo)'),
        m(1, 'bot', '¡Hola! Soy el asistente virtual del punto de venta. ¿La quieres de contado o a crédito? (demo)'),
        m(3, 'cliente', l.forma_pago || 'Todavía no sé'),
        m(4, 'bot', 'Perfecto. Te asigno a ' + l.nombre_asesor + ' del punto ' + sedeCanon(l.punto_asignado) + '. (demo)'),
        { fecha_hora: fmtB(new Date(ahoraD - 2 * 3600e3)), remitente: 'cliente', mensaje: '¿Me confirman si hay en color negro? (demo)' }
      ].concat(extra.msgs), atencion: { estado: extra.estado, asesor: l.nombre_asesor || '', ventana_abierta: true, ventana_cierra: new Date(ahoraD + 22 * 3600e3).toISOString(),
        vence_reasignacion: extra.estado === 'asesor' ? new Date(ahoraD + 20 * 3600e3).toISOString() : '', puede_escribir: puedeVer(u, l), envio_configurado: true } };
    }
    if (action === 'bandeja') {
      const ahoraB = Date.now();
      const chats = DB.Leads.filter(l => puedeVer(u, l)).slice(0, 25).map((l, i) => {
        const c = DEMO_CHAT[l.id_lead] || { estado: l.nombre_asesor ? 'asesor' : 'bot', msgs: [] };
        const ult = c.msgs.length ? c.msgs[c.msgs.length - 1] : null;
        return { id_lead: l.id_lead, nombre: l.nombre_completo || l.username_whatsapp || 'Cliente', asesor: l.nombre_asesor || '', punto: sedeCanon(l.punto_asignado),
          ultimo: ult ? ult.mensaje : '¿Me confirman si hay en color negro? (demo)', remitente: ult ? 'asesor' : 'cliente',
          fecha: new Date(ahoraB - (ult ? 0 : (i + 1) * 47 * 60e3)).toISOString(), mensajes: 5 + c.msgs.length, estado: c.estado, espera: !ult, ventana: i % 7 !== 6 };
      });
      return { ok: true, chats };
    }
    if (action === 'enviarMensaje') {
      const l = DB.Leads.find(x => x.id_lead === p.id_lead);
      if (!l || !puedeVer(u, l)) fail('No tienes acceso a este lead.', 'FORBIDDEN');
      const c = (DEMO_CHAT[l.id_lead] = DEMO_CHAT[l.id_lead] || { estado: 'asesor', msgs: [] });
      c.msgs.push({ fecha_hora: fmtB(new Date()), remitente: 'asesor', mensaje: String(p.texto) + ' (demo: no se envía)' }); c.estado = 'asesor';
      return { ok: true };
    }
    if (action === 'atencion') {
      const l = DB.Leads.find(x => x.id_lead === p.id_lead);
      if (!l || !puedeVer(u, l)) fail('No tienes acceso a este lead.', 'FORBIDDEN');
      (DEMO_CHAT[l.id_lead] = DEMO_CHAT[l.id_lead] || { msgs: [] }).estado = p.estado === 'bot' ? 'bot' : 'asesor';
      return { ok: true, estado: DEMO_CHAT[l.id_lead].estado };
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
    // ── Etapa 2 ──
    const enPunto = s => esJefe || sedeCanon(s) === u.sede;
    const sinOcultas = rows => rows.map(r => { const o = Object.assign({}, r); delete o.costo; delete o.serie; return o; });
    if (action === 'modulo') {
      const R = REPO;
      if (p.m === 'seguimiento') return { ok: true, repoOk: true, daily: u.rol === 'asesor' ? [] : R.seguimientos.daily.filter(r => enPunto(r.punto)), checklist: u.rol === 'asesor' ? [] : R.seguimientos.checklist.filter(r => enPunto(r.punto)),
        compromisos: R.seguimientos.compromisos.filter(r => u.rol === 'asesor' ? norm(r.asesor) === norm(u.nombre) : enPunto(r.punto)) };
      if (p.m === 'posventa') return { ok: true, repoOk: true, interesados: R.posventa.interesados.filter(r => enPunto(r.punto)), ingresos: u.rol !== 'asesor' || u.recibe === 'posventa' ? R.posventa.ingresos : [] };
      if (u.rol === 'asesor') fail('Solo el Jefe Comercial y los administradores ven este módulo.', 'FORBIDDEN');
      if (p.m === 'inventario') {
        const tag = (rows, h) => sinOcultas(rows).map(r => Object.assign(r, { _hoja: h }));
        return { ok: true, repoOk: true, sistema: tag(R.inventario.motosIt, 'Motos_Itagui').concat(tag(R.inventario.motosLc, 'Motos_Los_Colores')),
          repuestos: tag(R.inventario.repIt, 'Repuestos_Itagui').concat(tag(R.inventario.repLc, 'Repuestos_Los_Colores')), pendiente: R.inventario.pendiente,
          facturacion: R.inventario.facturacion, conteos: R.inventario.conteos, equivalencias: [] };
      }
      if (p.m === 'cotizaciones') return { ok: true, repoOk: true, sintesis: R.cotizaciones.sintesis, crm: R.cotizaciones.crm, simulaciones: R.cotizaciones.simulaciones };
    }
    if (action === 'registrar') {
      const [rk, arr] = REPO_HOJA[p.hoja] || [];
      if (!rk) fail('No se puede registrar en ' + p.hoja, 'FORBIDDEN');
      const filas = p.filas || [p.fila];
      const unico = { Daily_Asesor: ['fecha', 'asesor'], Checklist_Semanal: ['semana', 'punto'], Compromisos_Semana: ['semana', 'asesor'] }[p.hoja];
      const ids = filas.map((f, i) => {
        const o = Object.assign({}, f, { id: p.hoja.slice(0, 3).toUpperCase() + '-' + Date.now() + i, registrado: fmtB(new Date()), registrado_por: u.nombre });
        if (u.rol === 'asesor' && p.hoja === 'Compromisos_Semana') { o.asesor = u.nombre; o.punto = u.sede; }
        if (unico && REPO[rk][arr].some(r => unico.every(c => String(r[c]).slice(0, 10) === String(o[c]).slice(0, 10)))) fail('Ya existe un registro para ' + unico.map(c => o[c]).join(' · ') + '.', 'DUPLICADO');
        REPO[rk][arr].push(o); return o.id;
      });
      return { ok: true, ids };
    }
    if (action === 'actualizar') {
      const [rk, arr] = REPO_HOJA[p.hoja] || [];
      const r = rk && REPO[rk][arr].find(x => x.id === p.id);
      if (!r) fail('Registro no encontrado.', 'NOROW');
      r[p.campo] = p.valor;
      return { ok: true };
    }
    if (action === 'importar') {
      const [rk, arr] = REPO_HOJA[p.hoja] || [];
      if (!rk) fail('No se pueden cargar exportes en ' + p.hoja, 'FORBIDDEN');
      if (/^(Motos|Repuestos)_/.test(p.hoja) && !p.continuar && REPO[rk][arr].some(r => String(r._lote).slice(0, 10) === p.lote)) fail('Ya hay un corte de inventario con fecha ' + p.lote + '. Usa la fecha real del corte.', 'DUPLICADO');
      const huellas = new Set(REPO[rk][arr].map(r => JSON.stringify(Object.keys(r).filter(k => k[0] !== '_').sort().map(k => [k, String(r[k])]))));
      let ag = 0, rep = 0;
      p.filas.forEach(f => { const h = JSON.stringify(Object.keys(f).sort().map(k => [k, String(f[k])])); if (huellas.has(h) && !/^(Motos|Repuestos)_/.test(p.hoja)) { rep++; return; } huellas.add(h); REPO[rk][arr].push(Object.assign({ _lote: p.lote }, f)); ag++; });
      return { ok: true, agregadas: ag, repetidas: rep };
    }
    if (action === 'repos' || action === 'crearRepos') {
      if (!esJefe) fail('Solo el Jefe Comercial administra los repositorios.', 'FORBIDDEN');
      const estado = [['seguimientos', 'Seguimientos comerciales', ['Daily_Asesor', 'Checklist_Semanal', 'Compromisos_Semana', 'Seguimientos']], ['posventa', 'Posventa', ['Interesados', 'Ingresos_Taller']], ['cotizaciones', 'Cotizaciones', ['Cotizaciones_Sintesis', 'Cotizaciones_CRM']],
        ['inventario', 'Inventario', ['Motos_Itagui', 'Motos_Los_Colores', 'Repuestos_Itagui', 'Repuestos_Los_Colores', 'Pendiente_por_Llegar', 'Facturacion', 'Conteo_Fisico']], ['financieras', 'Financieras', ['Financieras']], ['bonos', 'Bonos', ['Bonos']]]
        .map(([key, n, hs]) => ({ key, nombre: 'CRM Motos · ' + n + ' (DEMO)', existe: true, configurado: true, url: '', hojas: hs.map(h => h + ' (demo)') }));
      return action === 'repos' ? { ok: true, repos: estado } : { ok: true, creados: [], estado };
    }
    if (action === 'vincularRepo') fail('En el modo demo no se vinculan archivos.', 'INVALID');
    fail('Acción no reconocida: ' + action);
  }

  window.AKT_DEMO = { handle, roles: ROLES };
})();
