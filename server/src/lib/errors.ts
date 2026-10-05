/** Every failure the client sees goes through AppError so responses stay uniform. */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: (m = 'Please log in to continue.') => new AppError(401, 'UNAUTHORIZED', m),
  forbidden: (m = 'You do not have access to this.') => new AppError(403, 'FORBIDDEN', m),
  notFound: (what = 'Item') => new AppError(404, 'NOT_FOUND', `${what} not found.`),
  badRequest: (m: string, code = 'BAD_REQUEST', details?: unknown) =>
    new AppError(400, code, m, details),
  conflict: (m: string, code = 'CONFLICT') => new AppError(409, code, m),
  outOfZone: () =>
    new AppError(400, 'OUT_OF_ZONE', 'Delivery is currently unavailable at this location.'),
  vendorClosed: () => new AppError(400, 'VENDOR_CLOSED', 'This stall is closed right now.'),
  itemUnavailable: (name: string) =>
    new AppError(400, 'ITEM_UNAVAILABLE', `${name} is not available right now.`),
  emptyCart: () => new AppError(400, 'EMPTY_CART', 'Your cart is empty.'),
  belowMinimum: (minRupees: string) =>
    new AppError(400, 'BELOW_MINIMUM', `Minimum order for this area is Rs ${minRupees}.`),
  paymentPending: () =>
    new AppError(409, 'PAYMENT_PENDING', 'This order is waiting for payment to be confirmed.'),
  invalidPayment: (m = 'We could not verify this payment.') => new AppError(400, 'INVALID_PAYMENT', m),
  paymentAlreadyCompleted: () =>
    new AppError(409, 'PAYMENT_ALREADY_COMPLETED', 'This order has already been paid.'),
  accountSuspended: () => new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended.'),
  googleEmailNotVerified: () =>
    new AppError(403, 'GOOGLE_EMAIL_NOT_VERIFIED', 'Your Google email is not verified.'),
  googleNotAllowed: () =>
    new AppError(403, 'GOOGLE_NOT_ALLOWED', 'Google sign-in is only available for customer accounts.'),
  tooManyRequests: (m: string, code = 'RATE_LIMITED') => new AppError(429, code, m),
  invalidTransition: (from: string, to: string) =>
    new AppError(409, 'INVALID_TRANSITION', `Cannot change order from ${from} to ${to}.`),
};
