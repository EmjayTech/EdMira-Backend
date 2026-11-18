import { Logger } from '@nestjs/common';
import { ClientSession, Connection } from 'mongoose';

const logger = new Logger('Transactions');
const support = new WeakMap<Connection, Promise<boolean>>();

/** Atlas (a replica set) supports transactions; a standalone mongod doesn't. */
function supportsTransactions(connection: Connection): Promise<boolean> {
  let known = support.get(connection);
  if (!known) {
    known = connection.db
      .admin()
      .command({ hello: 1 })
      .then(hello => {
        const ok = !!hello.setName || hello.msg === 'isdbgrid';
        if (!ok) logger.warn('MongoDB is standalone: study records are written without a transaction (the nightly job repairs totals).');
        return ok;
      })
      .catch(() => false);
    support.set(connection, known);
  }
  return known;
}

/**
 * Runs `work` in one transaction (retried by the driver on transient
 * conflicts, so `work` must only read and write through `session`). On a
 * standalone server it runs without one; the unique keys still stop double
 * points.
 */
export async function inTransaction<T>(
  connection: Connection,
  work: (session: ClientSession | undefined) => Promise<T>,
): Promise<T> {
  if (!(await supportsTransactions(connection))) return work(undefined);
  const session = await connection.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result!;
  } finally {
    await session.endSession();
  }
}
