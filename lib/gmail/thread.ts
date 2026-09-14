// A follow-up's subject.
//
// Gmail files a message into the threadId it is sent with only when the
// subject matches the thread's. Otherwise it quietly starts a new conversation
// in the sender's mailbox, and the prospect's Gmail splits it the same way. The
// T2-T4 templates carried their own "Re: ..." subject, which only matched a T1
// sent from the same template set; against a T1 somebody wrote by hand, every
// one of the app's follow-ups arrived as a stranger's first email.
//
// No imports, so the composer can show the same subject the dispatcher sends.

const REPLY_PREFIX = /^\s*(?:(?:re|fwd?|aw|sv)\s*(?:\[\d+\])?\s*:\s*)+/i;

/** "Re: <the thread's subject>", with any stack of Re:/Fwd: collapsed. */
export function replySubject(threadSubject: string): string {
  const base = threadSubject.replace(REPLY_PREFIX, "").trim();
  return base ? `Re: ${base}` : threadSubject;
}
