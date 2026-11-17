// Vercel Function entry point, served at /api. All logic lives in lib/app.js.
import { handle } from '../lib/app.js';

export default {
  fetch(request) {
    return handle(request);
  },
};
