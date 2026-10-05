/**
 * What a UPI app handed back when it said a payment went through: the ids to
 * find the payment by in a bank or UPI statement. Shown to the payer when it
 * settles, and to everyone in the group's history.
 *
 * The transaction ID and the approval reference always get a row, so that an
 * app which left one out is seen to have left it out. The link's own
 * reference only comes back when the link asked for one, and Sattle's links
 * don't, so it gets a row only when it is there.
 */

import React from 'react';

import type { UpiReceipt } from '@sattle/core';
import { BreakdownRow } from './primitives';

const NOT_GIVEN = 'Not given by the UPI app';

export function UpiReceiptRows({ receipt }: { receipt: UpiReceipt }) {
  return (
    <>
      <BreakdownRow label="UPI transaction ID" value={receipt.txnId ?? NOT_GIVEN} numeric={Boolean(receipt.txnId)} />
      <BreakdownRow label="Approval ref" value={receipt.approvalRef ?? NOT_GIVEN} numeric={Boolean(receipt.approvalRef)} />
      {receipt.txnRef && <BreakdownRow label="Transaction ref" value={receipt.txnRef} numeric />}
    </>
  );
}
