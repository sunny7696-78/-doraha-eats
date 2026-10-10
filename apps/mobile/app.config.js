/**
 * Extends app.json. Android push (Firebase/FCM) needs google-services.json inside the build.
 *
 * Where the file comes from, in order:
 *  1. EAS file variable GOOGLE_SERVICES_JSON (recommended: nothing to commit, and it always
 *     reaches the cloud build, whatever git/zip state your folder is in)
 *  2. ./google-services.json next to this file (only if it is actually included in the upload)
 * If neither exists the build still works, push is just off.
 */
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const local = path.join(__dirname, 'google-services.json');
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON || (fs.existsSync(local) ? './google-services.json' : undefined);
  return {
    ...config,
    android: { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) },
  };
};
