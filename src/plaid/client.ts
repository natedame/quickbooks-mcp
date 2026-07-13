// Thin, read-only Plaid client wrapper.
//
// Plaid is the bank FEED: it reads transactions and balances, and it never
// moves money. Every method here either connects the bank (a one-time human
// click) or reads from it. There is deliberately no method that could initiate
// a transfer — the read-only-on-the-bank boundary is what keeps this safe.

import { CountryCode, Products, type PlaidApi } from "plaid";
import { getPlaidClient, type PlaidEnv } from "./config.js";
import { selectCapturedSession, type CapturedSession, type LinkSession } from "./connect-flow.js";

export interface HostedLink {
  link_token: string;
  hosted_link_url: string;
  expiration: string;
}

export interface ExchangedItem {
  access_token: string;
  item_id: string;
}

export interface InstitutionInfo {
  institution_id: string;
  name: string;
  oauth: boolean;
  products: string[];
  supports_transactions: boolean;
}

export interface AccountBalance {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  current: number | null;
  available: number | null;
  iso_currency_code?: string | null;
}

export interface SyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
  accounts?: AccountBalance[];
}

/** The subset of a Plaid transaction the pipeline reads. */
export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Plaid sign convention: POSITIVE = money OUT of the account (debit); NEGATIVE = money IN (credit). */
  amount: number;
  iso_currency_code?: string | null;
  date: string;
  authorized_date?: string | null;
  name: string;
  merchant_name?: string | null;
  /** Pending items get a DIFFERENT transaction_id when they post — book pending=false ONLY. */
  pending: boolean;
  pending_transaction_id?: string | null;
  personal_finance_category?: { primary: string; detailed: string; confidence_level?: string } | null;
  payment_channel?: string;
}

export class PlaidClient {
  private api: PlaidApi;
  readonly env: PlaidEnv;

  constructor(api?: PlaidApi, env: PlaidEnv = "sandbox") {
    this.api = api || getPlaidClient();
    this.env = env;
  }

  /**
   * Create a Hosted Link — the URL Nate clicks once to connect the bank and
   * grant read access. Presence of `hosted_link` makes Plaid host the flow, so
   * there is no client-side Link SDK to build.
   *
   * `urlLifetimeSeconds` sets how long the generated URL stays clickable. Without
   * it Plaid defaults a hosted link to only 30 minutes, which is too short for a
   * human to get to it — so the connect runner passes a generous value (max 21
   * days per Plaid). NOTE this is a different clock from the ~6h retention of the
   * session RESULT after the user finishes; the runner handles that separately.
   */
  async createHostedLink(
    clientUserId: string,
    opts: { urlLifetimeSeconds?: number } = {}
  ): Promise<HostedLink> {
    const resp = await this.api.linkTokenCreate({
      user: { client_user_id: clientUserId },
      client_name: "Profound Strategy Bookkeeping",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
      hosted_link: opts.urlLifetimeSeconds
        ? { url_lifetime_seconds: opts.urlLifetimeSeconds }
        : {},
    });
    const data = resp.data as { link_token: string; expiration: string; hosted_link_url?: string };
    if (!data.hosted_link_url) {
      throw new Error("Plaid did not return a hosted_link_url — check that Hosted Link is enabled for this client.");
    }
    return {
      link_token: data.link_token,
      hosted_link_url: data.hosted_link_url,
      expiration: data.expiration,
    };
  }

  /**
   * Poll a Hosted Link session's outcome via `/link/token/get`. This is how
   * Hosted Link returns the `public_token` (there is no frontend callback):
   * once the user finishes, `link_sessions[]` carries the result for up to ~6h.
   * Returns the captured public_token (+ institution) when a finished session
   * succeeded, an `exited` flag if the user abandoned, or `finished:false` while
   * still in progress. Read-only.
   */
  async getLinkSessionResult(linkToken: string): Promise<CapturedSession> {
    const resp = await this.api.linkTokenGet({ link_token: linkToken });
    const sessions = (resp.data.link_sessions || []) as LinkSession[];
    return selectCapturedSession(sessions);
  }

  /** Exchange a public_token (from Hosted Link or sandbox) for a durable access_token. */
  async exchangePublicToken(publicToken: string): Promise<ExchangedItem> {
    const resp = await this.api.itemPublicTokenExchange({ public_token: publicToken });
    return { access_token: resp.data.access_token, item_id: resp.data.item_id };
  }

  /**
   * Mint a sandbox public_token directly (no bank UI) so the full flow can be
   * proven end-to-end on sandbox. Sandbox environment only.
   */
  async createSandboxPublicToken(institutionId = "ins_109508"): Promise<string> {
    const resp = await this.api.sandboxPublicTokenCreate({
      institution_id: institutionId,
      initial_products: [Products.Transactions],
    });
    return resp.data.public_token;
  }

  /** Look up an institution's auth type + product support (used to confirm a real bank before connecting). */
  async getInstitution(institutionId: string): Promise<InstitutionInfo> {
    const resp = await this.api.institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Us],
      options: { include_optional_metadata: true },
    });
    const inst = resp.data.institution;
    const products = (inst.products || []).map(String);
    return {
      institution_id: inst.institution_id,
      name: inst.name,
      oauth: Boolean(inst.oauth),
      products,
      supports_transactions: products.includes("transactions"),
    };
  }

  /** Resolve the institution_id for a connected item (item/get). */
  async getItemInstitutionId(accessToken: string): Promise<string | undefined> {
    const resp = await this.api.itemGet({ access_token: accessToken });
    return resp.data.item.institution_id || undefined;
  }

  /** One incremental transactions/sync page. Caller loops while has_more. */
  async syncTransactions(accessToken: string, cursor?: string): Promise<SyncPage> {
    const resp = await this.api.transactionsSync({
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
    });
    const d = resp.data as unknown as {
      added: PlaidTransaction[];
      modified: PlaidTransaction[];
      removed: { transaction_id: string }[];
      next_cursor: string;
      has_more: boolean;
      accounts?: RawAccount[];
    };
    return {
      added: d.added,
      modified: d.modified,
      removed: d.removed,
      next_cursor: d.next_cursor,
      has_more: d.has_more,
      accounts: d.accounts ? d.accounts.map(mapBalance) : undefined,
    };
  }

  /**
   * Real-time balances (accounts/balance/get). This is the billable Balance
   * call — the pipeline prefers the free balances returned by syncTransactions
   * and only calls this to confirm a suspected discrepancy.
   */
  async getBalances(accessToken: string): Promise<AccountBalance[]> {
    const resp = await this.api.accountsBalanceGet({ access_token: accessToken });
    return resp.data.accounts.map(mapBalance);
  }
}

interface RawAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: { current: number | null; available: number | null; iso_currency_code?: string | null };
}

function mapBalance(a: RawAccount): AccountBalance {
  return {
    account_id: a.account_id,
    name: a.name,
    official_name: a.official_name,
    mask: a.mask,
    type: String(a.type),
    subtype: a.subtype ? String(a.subtype) : null,
    current: a.balances.current,
    available: a.balances.available,
    iso_currency_code: a.balances.iso_currency_code,
  };
}
