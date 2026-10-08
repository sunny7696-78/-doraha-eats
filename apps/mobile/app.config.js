/**
 * Extends app.json. Android push (Firebase/FCM) needs google-services.json inside the app build.
 * It is added ONLY when the file exists in this folder, so builds still work without it
 * (push is simply off) and nothing breaks for people who have not set up Firebase.
 */
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const hasGoogleServices = fs.existsSync(path.join(__dirname, 'google-services.json'));
  return {
    ...config,
    android: {
      ...config.android,
      ...(hasGoogleServices ? { googleServicesFile: './google-services.json' } : {}),
    },
  };
};
