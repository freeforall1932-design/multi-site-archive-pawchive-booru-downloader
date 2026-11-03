// Preview harness controls. The iframes above run the real UI modules in preview
// mode; this file only wires up navigation and the reset button.

const optionsFrame = document.getElementById('options-frame');
const popupFrame = document.getElementById('popup-frame');
const panelFrame = document.getElementById('panel-frame');

/**
 * The panel reads the "active tab" from its own `?tab=` query string in preview
 * mode, so switching that parameter is the preview's way of simulating "the user
 * is looking at a different page".
 */
function openPanelAs(url, hash) {
  const suffix = url ? `?tab=${encodeURIComponent(url)}` : '';
  const target = `../../dist/panel/panel.html${suffix}${hash ?? ''}`;
  if (panelFrame) {
    panelFrame.src = target;
    panelFrame.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    window.open(target, '_blank', 'noopener');
  }
}

document.getElementById('open-panel')?.addEventListener('click', () => openPanelAs('https://e621.net/posts/1500000'));
document.getElementById('open-panel-queue')?.addEventListener('click', () => openPanelAs('https://e621.net/posts?tags=cat', '#queue'));
// A multi-file fixture for exercising the post card's all-files action offline.
document.getElementById('open-panel-pawchive')?.addEventListener('click', () =>
  openPanelAs('https://pawchive.pw/fanbox/user/1245946/post/12674481'),
);
// A creator page: the Links tab picks up the profile and the creator from it.
document.getElementById('open-panel-links')?.addEventListener('click', () =>
  openPanelAs('https://pawchive.pw/fanbox/user/1245946', '#links'),
);

document.getElementById('open-options')?.addEventListener('click', () => {
  window.open('../../dist/options/options.html', '_blank', 'noopener');
});

document.getElementById('open-popup')?.addEventListener('click', () => {
  window.open('../../dist/popup/popup.html?tab=https%3A%2F%2Fe621.net%2Fposts%2F1500000', '_blank', 'noopener');
});

document.getElementById('reset')?.addEventListener('click', () => {
  const confirmed = window.confirm('Clear preview storage and reload the harness?');
  if (!confirmed) return;
  Object.keys(localStorage)
    .filter((key) => key.startsWith('bsm-preview:'))
    .forEach((key) => localStorage.removeItem(key));
  optionsFrame?.contentWindow?.location.reload();
  popupFrame?.contentWindow?.location.reload();
  panelFrame?.contentWindow?.location.reload();
  window.location.reload();
});
