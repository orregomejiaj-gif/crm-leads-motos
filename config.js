/**
 * Configuración pública de la app. Aquí NO va ninguna contraseña ni clave:
 * la contraseña de acceso (APP_PASSWORD) y el ID del Sheet viven en las
 * Propiedades del script de Apps Script.
 */
window.AKT_CONFIG = {
  // URL /exec de la implementación del Apps Script (backend/Code.gs).
  // Ejemplo: 'https://script.google.com/macros/s/AKfy.../exec'
  // Implementación activa desde la v2.6.0 (3-oct-2026). La anterior (AKfycbwMK6…) quedó en la v2.5.0.
  API_URL: 'https://script.google.com/macros/s/AKfycbznBSzZc1E3Kd85y8jkN2o09L_WMLOIC2SEpwnciZglV7VX4qi8WcgnE6MiWCen91O7TA/exec',
  // Refresco automático (ms). Brief: cada 1–2 minutos.
  REFRESH_MS: 90000
};
