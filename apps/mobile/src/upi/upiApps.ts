/**
 * The UPI apps on an Android phone, and what each can do with a pay link.
 *
 * NPCI told every payer app to refuse a upi://pay link that another app
 * opens when the payee is a person rather than a merchant (circular OC/76A,
 * in force since 1 April 2024). Google Pay and PhonePe do, and say something
 * about a limit when they do. A debt here is always owed to a person, so
 * those two are never sent the link: the UPI ID is copied, the app is opened
 * plain, and the payer pastes it in and types the amount. Other apps still
 * take the link, and some hand back what happened.
 */

/** A UPI app on the phone, as the native module lists it (modules/upi-apps). */
export interface UpiApp {
  /** Android's name for it, which is what it's opened by. */
  packageName: string;
  /** The name under its icon. */
  name: string;
  /** Its icon as a data: URL, or null when Android couldn't draw it. */
  icon: string | null;
}

const REFUSE_LINKS: ReadonlySet<string> = new Set([
  'com.google.android.apps.nbu.paisa.user', // Google Pay
  'com.phonepe.app', // PhonePe
]);

/** Whether `app` refuses a pay link from another app, so it is paid in by hand instead. */
export function refusesLinks(app: Pick<UpiApp, 'packageName'>): boolean {
  return REFUSE_LINKS.has(app.packageName);
}
