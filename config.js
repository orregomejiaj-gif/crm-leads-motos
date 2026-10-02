/**
 * Configuración pública de la app. Aquí NO va ninguna contraseña ni clave:
 * la contraseña de acceso (APP_PASSWORD) y el ID del Sheet viven en las
 * Propiedades del script de Apps Script.
 */
window.AKT_CONFIG = {
  // URL /exec de la implementación del Apps Script (backend/Code.gs).
  // Ejemplo: 'https://script.google.com/macros/s/AKfy.../exec'
  API_URL: 'https://script.google.com/macros/s/AKfycbwMK6XQCF_UIPIXhEuYsrcc6ibSAThNUXv2GpYMel-oW7UvJRLdZ0CYNtmDUZiJMNIX/exec',
  // Refresco automático (ms). Brief: cada 1–2 minutos.
  REFRESH_MS: 90000
};
