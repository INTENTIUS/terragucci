import { schema, sequence, type } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema`
  CREATE SCHEMA app;
  COMMENT ON SCHEMA app IS 'The shop'`;

export const orderStatus = type`
  CREATE TYPE ${app}.order_status AS ENUM ('placed', 'paid', 'shipped', 'cancelled')`;

// Invoice numbers start at 1000; orders take theirs with nextval(${invoiceSeq}).
export const invoiceSeq = sequence`
  CREATE SEQUENCE ${app}.invoice_seq AS bigint START WITH 1000`;
