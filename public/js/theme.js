/**
 * Theme switch. A classic script, loaded in <head>, deliberately NOT part of
 * the app module: the stored theme has to be on <html> before the first paint,
 * and a module is deferred - you would watch the console repaint itself on
 * every load. Ten lines here buy that.
 *
 * Everything a theme is lives in app.css; this file only remembers which one.
 */
(function () {
  var KEY = 'csmig.theme';
  var DEFAULT = 'emerald';
  // Must match the :root[data-theme=...] blocks in app.css and the <option>
  // list in index.html. A name that is not here falls back to the default
  // rather than leaving the page on an attribute no stylesheet answers.
  var THEMES = ['cupcake', 'emerald', 'corporate', 'retro', 'valentine',
    'lofi', 'pastel', 'autumn', 'lemonade', 'winter'];

  function stored() {
    // Private-mode browsers throw on localStorage rather than returning null.
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  var theme = THEMES.indexOf(stored()) >= 0 ? stored() : DEFAULT;
  document.documentElement.dataset.theme = theme;

  document.addEventListener('DOMContentLoaded', function () {
    var sel = document.getElementById('theme-pick');
    if (!sel) return;
    sel.value = theme;
    sel.addEventListener('change', function () {
      document.documentElement.dataset.theme = sel.value;
      try { localStorage.setItem(KEY, sel.value); } catch (e) { /* not worth a toast */ }
    });
  });
}());
