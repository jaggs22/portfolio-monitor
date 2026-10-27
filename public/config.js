/* Settings you may want to change before sending the app out. */
window.APP_CONFIG = {
  appName: 'Moat Monitor',

  // Where the "Send feedback" button sends the week's notes. Leave empty to use the
  // share sheet instead. Set it to your own address before sending the app out.
  feedbackEmail: '',

  // How many items the digest puts under "Needs attention".
  maxAttention: 3,
  // The digest is older than this many hours: show a stale-data warning.
  staleHours: 30
};
