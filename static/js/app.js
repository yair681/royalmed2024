/* ============================================================
   רויאל-מד | app.js — פונקציות JavaScript משותפות
   ============================================================ */

// Flash messages — נעלמות אוטומטית
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.flash-message').forEach(function (el) {
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.4s';
      setTimeout(function () { el.remove(); }, 400);
    }, 4000);
  });
});
