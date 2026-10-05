/**
 * Razorpay checkout for the customer app.
 *
 * Trust model: the app NEVER decides a payment succeeded. After the Razorpay sheet returns,
 * the signed result is sent to the backend, which verifies the signature and the payment with
 * Razorpay itself; the Razorpay webhook is the second, independent confirmation. The UI only
 * shows "Paid" once the order's paymentStatus (from the database) is PAID.
 *
 * Needs a native build (react-native-razorpay is not in Expo Go): `eas build --profile development`.
 */
import { Platform } from 'react-native';
import { api } from '../../lib/api';
import type { OrderDetail, PaymentCheckout } from '../orders/api';

export type PayResult =
  | { kind: 'verified'; order: OrderDetail }   // backend confirmed PAID
  | { kind: 'processing'; order: OrderDetail } // paid at Razorpay, backend/webhook still settling
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };
export const razorpaySupported = Platform.OS !== 'web';

type SheetSuccess = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };

function loadSdk(): { open: (o: Record<string, unknown>) => Promise<SheetSuccess> } | null {
  if (!razorpaySupported) return null;
  try {
    // Lazy require: the web bundle and Expo Go must not crash on the missing native module.
    return require('react-native-razorpay').default;
  } catch { return null; }
}

export const getCheckoutForRetry = (orderId: string) =>
  api<{ paymentCheckout: PaymentCheckout }>(`/orders/${orderId}/payment/retry`, { method: 'POST' });

export const verifyPayment = (orderId: string, r: SheetSuccess) =>
  api<{ verified: boolean; order: OrderDetail }>(`/orders/${orderId}/payment/verify`, { method: 'POST', body: r });

/** Opens the Razorpay sheet for an order's existing Razorpay order, then verifies on the server. */
export async function payForOrder(
  orderId: string, checkout: PaymentCheckout, prefill?: { contact?: string; email?: string; name?: string },
): Promise<PayResult> {
  const sdk = loadSdk();
  if (!sdk) {
    return { kind: 'failed', message: 'Online payment needs the installed Doraha Eats app (not Expo Go / web). Please use Cash on Delivery or update the app.' };
  }

  let result: SheetSuccess;
  try {
    result = await sdk.open({
      key: checkout.keyId,
      order_id: checkout.razorpayOrderId, // amount comes from the server-created Razorpay order, not the client
      currency: checkout.currency,
      name: checkout.name,
      description: checkout.description,
      prefill,
      theme: { color: '#E8552D' },
    });
  } catch (e) {
    const err = e as { code?: number; description?: string };
    if (err?.code === 2) return { kind: 'cancelled' };
    return { kind: 'failed', message: err?.description || 'Payment failed. You have not been charged, or any charge will be refunded.' };
  }

  try {
    const { verified, order } = await verifyPayment(orderId, result);
    return verified ? { kind: 'verified', order } : { kind: 'processing', order };
  } catch {
    // Money may have moved but we could not reach the server: the webhook will still settle it.
    return { kind: 'failed', message: 'We could not confirm your payment yet. If you were charged, your order will update automatically in a minute.' };
  }
}
