import { index, table } from "@intentius/chant-lexicon-sql/postgres";
import { app, invoiceSeq, orderStatus } from "./app";
import { users } from "./users";

export const orders = table`
  CREATE TABLE ${app}.orders (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES ${users} (${users.columns.id}) ON DELETE CASCADE,
    invoice_no bigint NOT NULL DEFAULT nextval(${invoiceSeq}),
    status     ${orderStatus} NOT NULL DEFAULT 'placed',
    amount     numeric(12, 2) NOT NULL CHECK (amount >= 0),
    placed_at  timestamptz NOT NULL DEFAULT now()
  )`;

// The index is named: the name is its identity on the server.
export const ordersUserId = index`
  CREATE INDEX orders_user_id_idx ON ${orders} (${orders.columns.user_id}, ${orders.columns.placed_at} DESC)`;
