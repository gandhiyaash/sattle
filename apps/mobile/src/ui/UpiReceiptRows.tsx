/**
 * What there is to find a UPI payment by in a bank or UPI statement, when it
 * was settled on the payer's side's word. Shown to the payer when it
 * settles, and to everyone in the group's history.
 *
 * From a UPI app (Android): the transaction ID and the approval reference
 * always get a row, so that an app which left one out is seen to have left
 * it out. The link's own reference only comes back when the link asked for
 * one, and Sattle's links don't, so it gets a row only when it is there.
 *
 * Said by the payer, where no app reports: the reference they typed in, if
 * they gave one, and nothing if they didn't.
 */

import React from 'react';

import type { UpiReceipt } from '@sattle/core';
import { BreakdownRow } from './primitives';

const NOT_GIVEN = 'Not given by the UPI app';

export function UpiReceiptRows({ receipt }: { receipt: UpiReceipt }) {
  if (receipt.byPayer) {
    return receipt.reference ? <BreakdownRow label="UPI reference" value={receipt.reference} numeric /> : null;
  }
  return (
    <>
      <BreakdownRow label="UPI transaction ID" value={receipt.txnId ?? NOT_GIVEN} numeric={Boolean(receipt.txnId)} />
      <BreakdownRow label="Approval ref" value={receipt.approvalRef ?? NOT_GIVEN} numeric={Boolean(receipt.approvalRef)} />
      {receipt.txnRef && <BreakdownRow label="Transaction ref" value={receipt.txnRef} numeric />}
    </>
  );
}
