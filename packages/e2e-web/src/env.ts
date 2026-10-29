/**
 * Where the two servers under test listen. Fixed ports, so the web build can
 * have the API's address baked in (EXPO_PUBLIC_API_URL is read at export time)
 * and the API can allow exactly the web origin in CORS.
 */

export const API_PORT = 3900;
export const WEB_PORT = 8900;
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

/**
 * The simulated payment backend's timings. A payment walks created →
 * awaiting_payment → in_flight → confirmed, pausing STEP between the first
 * three and SETTLE before the last. The invoice (awaiting_payment) has to stay
 * up long enough for a page polling every 2 s to show it, so STEP is not tiny.
 */
export const SIM_STEP_MS = 1200;
export const SIM_SETTLE_MS = 400;
/** INR per BTC the simulator quotes at. ₹90,00,000, as in apps/api/.env.example. */
export const SIM_RATE_FIAT_PER_BTC = 9_000_000;
