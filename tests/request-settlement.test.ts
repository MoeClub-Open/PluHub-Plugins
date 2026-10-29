import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  recoverRequestSettlements,
  settleRequest,
} from "../plugins/billing/settlement.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE reservations(id TEXT PRIMARY KEY,user_id TEXT,amount INTEGER,status TEXT,actual INTEGER,pricing TEXT,reported_usage TEXT,receipt TEXT,note TEXT);
    CREATE TABLE ledger(source TEXT UNIQUE,amount INTEGER);`);
  const add = (id: string, status = "reserved", usage?: object) => {
    db.prepare(
      "INSERT INTO reservations(id,user_id,amount,status,pricing,reported_usage) VALUES(?,'alice',100,?,?,?)",
    ).run(
      id,
      status,
      JSON.stringify({ input: 1, output: 2 }),
      usage ? JSON.stringify(usage) : null,
    );
    return db.prepare("SELECT * FROM reservations WHERE id=?").get(id) as any;
  };
  const post = (_user: string, amount: number, source: string) => {
    db.prepare("INSERT INTO ledger VALUES(?,?)").run(source, amount);
  };
  return { db, add, post };
}

it("settles an interrupted request from valid usage or its reservation without inventing usage", () => {
  const f = fixture();
  try {
    expect(
      settleRequest(f.db, f.post, f.add("usage"), {
        usage: { input: 20, output: 10 },
      }).amount,
    ).toBe(40);
    expect(settleRequest(f.db, f.post, f.add("unknown"))).toMatchObject({
      mode: "reserved",
      amount: 100,
    });
    const rows = f.db
      .prepare(
        "SELECT status,actual,reported_usage,receipt FROM reservations ORDER BY id",
      )
      .all() as any[];
    expect(rows.every((row) => row.status === "settled")).toBe(true);
    expect(rows[0].reported_usage).toBeNull();
    expect(JSON.parse(rows[0].receipt).usage).toBeUndefined();
    expect(
      f.db.prepare("SELECT SUM(amount) amount FROM ledger").get()!.amount,
    ).toBe(-140);
  } finally {
    f.db.close();
  }
});

it("finishes historical reviews and interrupted reservations exactly once", () => {
  const f = fixture();
  try {
    f.add("review", "review", { input: 20, output: 10 });
    f.add("interrupted");
    recoverRequestSettlements(f.db, f.post);
    recoverRequestSettlements(f.db, f.post);
    expect(
      f.db
        .prepare("SELECT COUNT(*) n FROM reservations WHERE status!='settled'")
        .get()!.n,
    ).toBe(0);
    expect(
      f.db.prepare("SELECT COUNT(*) n,SUM(amount) amount FROM ledger").get(),
    ).toMatchObject({ n: 2, amount: -140 });
  } finally {
    f.db.close();
  }
});

it("uses the reserved amount for invalid costs and provider output-limit violations", () => {
  const f = fixture();
  try {
    expect(
      settleRequest(f.db, f.post, f.add("invalid"), {
        usage: { input: -1, output: 10 },
      }),
    ).toMatchObject({ mode: "reserved", amount: 100 });
    expect(
      settleRequest(f.db, f.post, f.add("limit"), {
        usage: { input: 20, output: 10000 },
        reservedReason: "Output limit exceeded; charged reserved amount",
      }),
    ).toMatchObject({ mode: "reserved", amount: 100 });
  } finally {
    f.db.close();
  }
});
