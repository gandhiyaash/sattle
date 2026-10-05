/**
 * The only seam between the UI and the backend. Screens talk to this and
 * nothing else, so MockClient and ApiClient are interchangeable.
 *
 * Adding a method? Add it to MockClient in the same change, so the app keeps
 * running without the server.
 *
 * Writes take an optional `idempotencyKey`. Pass the same key when the user
 * retries the same action (ActionKeys does this), so a request that reached
 * the server before its response was lost isn't carried out twice. Without
 * one, each call gets a fresh key.
 */

import type {
  CreateGroupInput,
  CreatePayLinkInput,
  CreateSettlementInput,
  CreateUpiClaimInput,
  Debt,
  Expense,
  ExpenseInput,
  Group,
  GroupGuestView,
  GroupLink,
  GuestView,
  Invite,
  InviteView,
  JoinAs,
  JoinRequest,
  LedgerBackup,
  Member,
  PayLink,
  PendingJoin,
  ReceiveAddress,
  Settlement,
  UpiClaim,
  UpiPayee,
  UpiProfile,
  User,
  WalletConnection,
  PaymentMode,
} from '@sattle/core';

export interface SattleClient {
  getCurrentUser(): Promise<User>;
  /** Real money or a simulation. Decides who can be offered Pay; see canReceive. */
  getPaymentMode(): Promise<PaymentMode>;

  getGroups(): Promise<Group[]>;
  getGroup(groupId: string): Promise<Group>;
  /** The creator becomes a joined member; everyone in memberNames starts as a ghost. */
  createGroup(input: CreateGroupInput, idempotencyKey?: string): Promise<Group>;
  getMembers(groupId: string): Promise<Member[]>;
  /** Adds a ghost. */
  addMember(groupId: string, displayName: string, idempotencyKey?: string): Promise<Member>;

  getExpenses(groupId: string): Promise<Expense[]>;
  addExpense(input: ExpenseInput, idempotencyKey?: string): Promise<Expense>;

  /** Netted debts, counting only confirmed settlements. */
  getDebts(groupId: string): Promise<Debt[]>;

  getSettlements(groupId: string): Promise<Settlement[]>;
  getSettlement(settlementId: string): Promise<Settlement>;
  /**
   * Returns in a non-terminal state. Subscribe with onSettlementUpdate for
   * the rest. Throws `member_cannot_receive` for a recipient with nowhere to
   * receive — call resolveSettlementOptions first so that never happens.
   */
  createSettlement(input: CreateSettlementInput, idempotencyKey?: string): Promise<Settlement>;
  markSettledManually(
    input: Omit<CreateSettlementInput, 'rail'> & { note?: string },
    idempotencyKey?: string
  ): Promise<Settlement>;
  /**
   * Proof of payment: the preimage the payer's wallet handed back. Confirms
   * the payment if it's this invoice's, even one already called expired
   * (it may have been paid late). Sending it twice is fine. Throws
   * `invalid_input` for anything else.
   */
  submitProof(settlementId: string, preimage: string, idempotencyKey?: string): Promise<Settlement>;
  /** Returns an unsubscribe function. */
  onSettlementUpdate(settlementId: string, cb: (s: Settlement) => void): () => void;

  /** Stores a payout address for a ghost. Their status stays `ghost`. */
  setMemberPayoutAddress(memberId: string, address: string): Promise<Member>;

  /** The group's ledger on Nostr, and the key that reads it back without this server. Members only. */
  getLedgerBackup(groupId: string): Promise<LedgerBackup>;

  // -- pay links ------------------------------------------------------------

  /** Only the person owed can create one. Share `${APP_URL}${payLinkPath(token)}`. */
  createPayLink(input: CreatePayLinkInput, idempotencyKey?: string): Promise<PayLink>;
  /**
   * Public. Call once when the guest page loads: mints a fresh invoice unless
   * one is already in progress. Throws `link_expired` if the debt is gone.
   */
  openPayLink(token: string): Promise<GuestView>;
  /** Public, read-only. */
  getGuestView(token: string): Promise<GuestView>;
  /**
   * Public. Proof of payment for any invoice this link opened; the view
   * shows the payment it proved. Throws `invalid_input` if it isn't one.
   */
  submitGuestProof(token: string, preimage: string, idempotencyKey?: string): Promise<GuestView>;
  /** Public. Returns an unsubscribe function. */
  onGuestViewUpdate(token: string, cb: (v: GuestView) => void): () => void;

  // -- invites --------------------------------------------------------------
  //
  // One link for the whole group: whoever opens it picks which of the people
  // who haven't joined they are, or gives their own name, and asks to join.
  // Someone already in the group lets them in, so a forwarded link can't be
  // used to become someone.

  /** The group's invite, or null when it has none that still works. */
  getGroupInvite(groupId: string): Promise<Invite | null>;
  /**
   * Makes the group's invite; anyone in the group can. If there was one, it
   * stops working. Share `${APP_URL}${invitePath(token)}`. Whoever is let in
   * with it becomes a full member, so it lasts a week.
   */
  createInvite(groupId: string, idempotencyKey?: string): Promise<Invite>;
  /** Turns the group's invite off. */
  removeInvite(groupId: string, idempotencyKey?: string): Promise<void>;
  /** Public. Throws `not_found` for a dead link, `link_expired` once it's too old. */
  getInvite(token: string): Promise<InviteView>;
  /**
   * The signed-in user asks to join the invite's group, and is in once someone
   * there says yes. With a `ref`, one of `getInvite`'s, they ask to be that
   * member; throws `conflict` if someone has joined as that person since.
   * With a `displayName`, they ask to be added as a new member; throws
   * `conflict` if that name is a member still waiting to be picked. Asking
   * again replaces their last request for the group.
   */
  askToJoin(token: string, as: JoinAs, idempotencyKey?: string): Promise<JoinRequest>;
  /** The user's own requests, waiting or turned down. One that was let in is gone, and the group is in getGroups. */
  getMyJoinRequests(): Promise<JoinRequest[]>;
  /** Takes back a request, or clears one that was turned down. */
  withdrawJoinRequest(requestId: string, idempotencyKey?: string): Promise<void>;
  /** Members only. Who is waiting to be let in, oldest first. */
  getPendingJoins(groupId: string): Promise<PendingJoin[]>;
  /**
   * Anyone in the group. They become the member they asked to be, or a new
   * one; anyone else asking to be that member is turned down. Throws
   * `conflict` if it was turned down already or someone joined as them since.
   */
  approveJoin(requestId: string, idempotencyKey?: string): Promise<Member>;
  /** Anyone in the group. The person asking sees it was turned down. */
  declineJoin(requestId: string, idempotencyKey?: string): Promise<void>;

  // -- group links ----------------------------------------------------------
  //
  // One link for the whole group: whoever holds it sees the spends and who
  // owes whom, and can pay a debt. It can't change anything.

  /** The group's link, or null when it has none. */
  getGroupLink(groupId: string): Promise<GroupLink | null>;
  /**
   * Makes the group's link; anyone in the group can. If there was one, it
   * stops working. Share `${APP_URL}${groupLinkPath(token)}`.
   */
  createGroupLink(groupId: string, idempotencyKey?: string): Promise<GroupLink>;
  /** Turns the group's link off. */
  removeGroupLink(groupId: string, idempotencyKey?: string): Promise<void>;
  /** Public. What the group page shows. Throws `not_found` for a link that was replaced or turned off. */
  getGroupGuestView(token: string): Promise<GroupGuestView>;
  /**
   * Public. Someone on the group page chose the debt `ref` to pay. Returns the
   * token of a pay link for it; open that like any pay link. Throws
   * `link_expired` if the debt is gone, `member_cannot_receive` if the person
   * owed has nowhere to receive.
   */
  payFromGroupLink(token: string, ref: string, idempotencyKey?: string): Promise<{ token: string }>;
  /**
   * Public. Where to pay the debt `ref` by UPI, when the person owed allows it
   * from shared links (the debt's `upi`). Throws `member_cannot_receive` when
   * they don't, `link_expired` if the debt is gone.
   */
  getGroupLinkUpi(token: string, ref: string): Promise<UpiPayee>;
  /**
   * Public. Says the debt `ref` was paid by UPI. Moves nothing: the person
   * owed confirms it. A claim already waiting for the debt is left as it is.
   */
  claimUpiFromGroupLink(token: string, ref: string, idempotencyKey?: string): Promise<void>;

  // -- changing and removing ------------------------------------------------
  //
  // Nobody can undo what someone else is owed: an expense is its payer's to
  // change, a group goes only once it's settled, and a member who is part of
  // the ledger stays in it. What you can always do is take yourself out.

  /**
   * Replaces what an expense says. Only the person who paid may, once they've
   * joined (`invalid_input` for anyone else); what a ghost paid, anyone in the
   * group may change. See canChangeExpense.
   */
  updateExpense(expenseId: string, input: ExpenseInput, idempotencyKey?: string): Promise<Expense>;
  /** Same rule as updateExpense. */
  deleteExpense(groupId: string, expenseId: string, idempotencyKey?: string): Promise<void>;

  renameGroup(groupId: string, name: string, idempotencyKey?: string): Promise<Group>;
  /** For everyone in it. Throws `conflict` while anything is owed or a payment is under way. */
  deleteGroup(groupId: string, idempotencyKey?: string): Promise<void>;
  /**
   * Removes a ghost that no expense or payment names. Throws `conflict` for
   * one that is part of the ledger, `invalid_input` for someone who has joined.
   */
  removeMember(groupId: string, memberId: string, idempotencyKey?: string): Promise<void>;
  /**
   * Your member becomes a ghost again, with its name and balance, and you
   * lose the group; an invite brings you back. Throws `conflict` if you're
   * the only one with an account, or a payment to you is under way.
   */
  leaveGroup(groupId: string, idempotencyKey?: string): Promise<void>;

  // -- wallet connection ----------------------------------------------------

  /** Throws `invalid_wallet` unless the connection grants NWC_REQUIRED_METHODS. */
  connectWallet(nwcUri: string): Promise<WalletConnection>;
  getWalletConnection(): Promise<WalletConnection>;
  /** The server forgets the connection string. Throws `conflict` while a payment to you is under way. */
  disconnectWallet(): Promise<WalletConnection>;

  /**
   * The user's own Lightning address for receiving, for wallets that can't do
   * NWC. Covers every group they're in; their NWC connection, if any, is used
   * first.
   */
  getReceiveAddress(): Promise<ReceiveAddress>;
  /**
   * The server asks the address for its payment details before saving, so a
   * typo is caught here. Throws `invalid_address`, or `network` if it didn't answer.
   */
  setReceiveAddress(address: string): Promise<ReceiveAddress>;
  clearReceiveAddress(): Promise<ReceiveAddress>;

  // -- UPI ------------------------------------------------------------------
  //
  // Settling a rupee debt outside Lightning. Sattle can't see a UPI payment,
  // so the payer says they paid (a claim) and the person owed confirms it.

  /** The user's own UPI ID, for every group they're in. */
  getUpiId(): Promise<UpiProfile>;
  /** Throws `invalid_input` when it isn't a UPI ID. A different ID is off shared links until turned on again. */
  setUpiId(upiId: string): Promise<UpiProfile>;
  /**
   * Whether anyone holding one of the user's groups' shared links may be
   * shown their UPI ID to pay them. Throws `invalid_input` with no ID set.
   */
  setUpiOnGroupLinks(on: boolean): Promise<UpiProfile>;
  clearUpiId(): Promise<UpiProfile>;
  /**
   * Where to pay a member over UPI. Only for someone who owes them: throws
   * `conflict` otherwise, and `member_cannot_receive` if they have no UPI ID.
   */
  getUpiPayee(groupId: string, memberId: string): Promise<UpiPayee>;
  /** The claims the user is part of in a group: the ones they made, and the ones waiting on them. */
  getUpiClaims(groupId: string): Promise<UpiClaim[]>;
  /**
   * The payer says they paid over UPI. Moves nothing, and takes the place of
   * their last claim for the same debt.
   */
  createUpiClaim(input: CreateUpiClaimInput, idempotencyKey?: string): Promise<UpiClaim>;
  /** The person owed says it arrived: the claim becomes a settlement. */
  confirmUpiClaim(claimId: string, idempotencyKey?: string): Promise<Settlement>;
  /** The person owed says it didn't arrive. The payer is shown that. */
  declineUpiClaim(claimId: string, idempotencyKey?: string): Promise<UpiClaim>;
  /** The payer takes their claim back. */
  withdrawUpiClaim(claimId: string, idempotencyKey?: string): Promise<void>;

  // -- account --------------------------------------------------------------

  /**
   * Ends the signed-in account for good: you leave every group (one only you
   * could open is deleted), and the wallet connection and the links you sent
   * go. Throws `conflict` while a payment to you is under way.
   */
  deleteAccount(): Promise<void>;
}

export function newIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * One idempotency key per user action. The same action with the same input
 * keeps its key until it succeeds, so retrying after a network error replays
 * the first attempt if it got through, instead of doing it twice.
 *
 * Keeping the key after any error is safe: the server only stores a key once
 * the request succeeds, so after a real failure the retry runs afresh.
 * Changing the input makes it a different action with a new key.
 *
 * Running the same action again while it's still in flight (a double tap)
 * joins that request instead of sending a second one, which the server
 * would refuse with "still being processed" even though the first worked.
 */
export class ActionKeys {
  private keys = new Map<string, string>();
  private inFlight = new Map<string, Promise<unknown>>();

  run<T>(action: string, input: unknown, fn: (key: string) => Promise<T>): Promise<T> {
    const id = `${action} ${JSON.stringify(input)}`;
    const running = this.inFlight.get(id);
    if (running) return running as Promise<T>;

    let key = this.keys.get(id);
    if (!key) this.keys.set(id, (key = newIdempotencyKey()));
    const k = key;
    const attempt = new Promise<T>((resolve) => resolve(fn(k)))
      .then((result) => {
        this.keys.delete(id);
        return result;
      })
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, attempt);
    return attempt;
  }
}
