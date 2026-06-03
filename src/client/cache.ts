// Account and department caching for QuickBooks lookups

import QuickBooks from "node-quickbooks";
import { promisify } from "./promisify.js";
import {
  CachedAccount,
  CachedCustomer,
  CachedDepartment,
  CachedVendor,
  CachedItem,
  AccountCache,
  DepartmentCache,
  VendorCache,
  QBQueryResponse,
} from "../types/index.js";

// Cache TTL (15 minutes)
const LOOKUP_CACHE_TTL_MS = 15 * 60 * 1000;

// Module-level cache state
let departmentCache: DepartmentCache | null = null;
let accountCache: AccountCache | null = null;
let vendorCache: VendorCache | null = null;
// Item cache: lazy per-entry lookup (not bulk-loaded like others)
const itemCacheById = new Map<string, CachedItem>();
const itemCacheByName = new Map<string, CachedItem>(); // lowercase key
// Customer cache: lazy per-entry lookup (companies can have thousands)
const customerCacheById = new Map<string, CachedCustomer>();
const customerCacheByName = new Map<string, CachedCustomer>(); // lowercase key

export function clearLookupCache(): void {
  departmentCache = null;
  accountCache = null;
  vendorCache = null;
  itemCacheById.clear();
  itemCacheByName.clear();
  customerCacheById.clear();
  customerCacheByName.clear();
}

// Helper to extract entities from QB query response with type safety
function extractQueryResults<T>(result: unknown, entityKey: string): T[] {
  const response = result as QBQueryResponse<T> | undefined;
  const entities = response?.QueryResponse?.[entityKey];
  return Array.isArray(entities) ? entities : [];
}

export async function getDepartmentCache(client: QuickBooks): Promise<DepartmentCache> {
  if (departmentCache && (Date.now() - departmentCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return departmentCache;
  }

  const result = await promisify<unknown>((cb) => client.findDepartments({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedDepartment>(result, 'Department');

  const byId = new Map<string, CachedDepartment>();
  const byName = new Map<string, CachedDepartment>();
  for (const dept of items) {
    byId.set(dept.Id, dept);
    byName.set(dept.Name.toLowerCase(), dept);
  }

  departmentCache = { items, byId, byName, fetchedAt: Date.now() };
  return departmentCache;
}

export async function getAccountCache(client: QuickBooks): Promise<AccountCache> {
  if (accountCache && (Date.now() - accountCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return accountCache;
  }

  const result = await promisify<unknown>((cb) => client.findAccounts({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedAccount>(result, 'Account');

  const byId = new Map<string, CachedAccount>();
  const byName = new Map<string, CachedAccount>();
  const byAcctNum = new Map<string, CachedAccount>();
  for (const acct of items) {
    byId.set(acct.Id, acct);
    byName.set(acct.Name.toLowerCase(), acct);
    if (acct.AcctNum) {
      byAcctNum.set(acct.AcctNum.toLowerCase(), acct);
    }
  }

  accountCache = { items, byId, byName, byAcctNum, fetchedAt: Date.now() };
  return accountCache;
}

// Resolve account by name, AcctNum, or ID using cache
export async function resolveAccount(client: QuickBooks, account: string): Promise<CachedAccount> {
  const cache = await getAccountCache(client);

  // Try exact ID match
  const byId = cache.byId.get(account);
  if (byId) return byId;

  // Try exact AcctNum match (case-insensitive)
  const byAcctNum = cache.byAcctNum.get(account.toLowerCase());
  if (byAcctNum) return byAcctNum;

  // Try exact name match (case-insensitive)
  const byName = cache.byName.get(account.toLowerCase());
  if (byName) return byName;

  // Try partial FullyQualifiedName match
  const byPartial = cache.items.find(a =>
    a.FullyQualifiedName?.toLowerCase().includes(account.toLowerCase())
  );
  if (byPartial) return byPartial;

  throw new Error(`Account not found: "${account}". Try using account name, number (AcctNum), or ID.`);
}

export async function getVendorCache(client: QuickBooks): Promise<VendorCache> {
  if (vendorCache && (Date.now() - vendorCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return vendorCache;
  }

  const result = await promisify<unknown>((cb) => client.findVendors({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedVendor>(result, 'Vendor');

  const byId = new Map<string, CachedVendor>();
  const byName = new Map<string, CachedVendor>();
  for (const vendor of items) {
    byId.set(vendor.Id, vendor);
    byName.set(vendor.DisplayName.toLowerCase(), vendor);
  }

  vendorCache = { items, byId, byName, fetchedAt: Date.now() };
  return vendorCache;
}

// Resolve vendor by name or ID using cache
// Returns { value, name } ref object for QuickBooks API
export async function resolveVendor(client: QuickBooks, nameOrId: string): Promise<{ value: string; name: string }> {
  const cache = await getVendorCache(client);

  // Try exact ID match
  const byId = cache.byId.get(nameOrId);
  if (byId) return { value: byId.Id, name: byId.DisplayName };

  // Try exact name match (case-insensitive)
  const byName = cache.byName.get(nameOrId.toLowerCase());
  if (byName) return { value: byName.Id, name: byName.DisplayName };

  // Try partial name match
  const byPartial = cache.items.find(v =>
    v.DisplayName.toLowerCase().includes(nameOrId.toLowerCase())
  );
  if (byPartial) return { value: byPartial.Id, name: byPartial.DisplayName };

  throw new Error(`Vendor not found: "${nameOrId}". Try using vendor display name or ID.`);
}

// Resolve item by name or ID using lazy per-entry cache
// Unlike other caches, items are fetched on demand (companies can have thousands)
export async function resolveItem(client: QuickBooks, nameOrId: string): Promise<{ value: string; name: string }> {
  // Check cache first (with TTL)
  const cached = itemCacheById.get(nameOrId) || itemCacheByName.get(nameOrId.toLowerCase());
  if (cached && (Date.now() - cached.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return { value: cached.Id, name: cached.Name };
  }

  // Query QB for this specific item
  // Try exact name match first, then partial
  const result = await promisify<unknown>((cb) =>
    client.findItems([
      { field: 'Name', value: nameOrId, operator: '=' },
      { field: 'Active', value: true, operator: '=' },
    ], cb)
  );
  let items = extractQueryResults<{ Id: string; Name: string; FullyQualifiedName?: string; Type?: string; UnitPrice?: number; Active?: boolean }>(result, 'Item');

  // If no exact match, try LIKE for partial matching
  if (items.length === 0) {
    const partialResult = await promisify<unknown>((cb) =>
      client.findItems([
        { field: 'Name', value: `%${nameOrId}%`, operator: 'LIKE' },
        { field: 'Active', value: true, operator: '=' },
      ], cb)
    );
    items = extractQueryResults<typeof items[0]>(partialResult, 'Item');
  }

  if (items.length === 0) {
    throw new Error(`Item not found: "${nameOrId}". Try using the exact item name or ID.`);
  }

  // Use first match and cache it
  const item = items[0];
  const entry: CachedItem = {
    Id: item.Id,
    Name: item.Name,
    FullyQualifiedName: item.FullyQualifiedName,
    Type: item.Type,
    UnitPrice: item.UnitPrice,
    Active: item.Active,
    fetchedAt: Date.now(),
  };
  itemCacheById.set(item.Id, entry);
  itemCacheByName.set(item.Name.toLowerCase(), entry);

  return { value: item.Id, name: item.Name };
}

// Helper to resolve department name to ID using cache
// Accepts: internal ID (e.g., "5"), name (e.g., "20400"), or partial match
export async function resolveDepartmentId(client: QuickBooks, department: string): Promise<string> {
  const cache = await getDepartmentCache(client);

  // Try exact ID match first
  const byId = cache.byId.get(department);
  if (byId) return byId.Id;

  // Try exact name match (case-insensitive)
  const byName = cache.byName.get(department.toLowerCase());
  if (byName) return byName.Id;

  // Try partial/fuzzy match on FullyQualifiedName
  const byPartial = cache.items.find(d =>
    d.FullyQualifiedName?.toLowerCase().includes(department.toLowerCase())
  );
  if (byPartial) return byPartial.Id;

  // If nothing found, return as-is (let API handle error)
  return department;
}

// Escape a value for safe interpolation into a QuickBooks query string.
// QB query values are single-quoted; apostrophes must be backslash-escaped
// (matches node-quickbooks' own criteriaToString quoting).
function escapeQbValue(value: string): string {
  return value.replace(/'/g, "\\'");
}

// Resolve customer by name or ID using lazy per-entry cache.
// Unlike vendor/account caches, customers are fetched on demand (companies can have thousands).
//
// Resolution order for the single nameOrId arg:
//   1. cache (by Id or lowercased DisplayName)
//   2. if the arg is Id-like (all digits): exact Id match (active OR inactive — an explicit
//      Id should resolve regardless of active status; QB otherwise filters inactive out)
//   3. exact active DisplayName match
//   4. partial (LIKE) active DisplayName match, first result wins
//
// All queries are passed as raw criteria STRINGS (not criteria-object arrays). node-quickbooks'
// array-criteria path hardcodes "maxresults 1000", which this QB realm returns 0 rows for on a
// filtered single-record lookup; the raw-string path (used by the query tool) avoids that and we
// additionally cap with a small "maxresults 10" so a broad LIKE never transfers the whole list.
export async function resolveCustomer(client: QuickBooks, nameOrId: string): Promise<{ value: string; name: string }> {
  // Check cache first (with TTL)
  const cached = customerCacheById.get(nameOrId) || customerCacheByName.get(nameOrId.toLowerCase());
  if (cached && (Date.now() - cached.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return { value: cached.Id, name: cached.DisplayName };
  }

  const queryCustomers = async (whereClause: string) => {
    const result = await promisify<unknown>((cb) =>
      client.findCustomers(`where ${whereClause} maxresults 10`, cb)
    );
    return extractQueryResults<{ Id: string; DisplayName: string; Active?: boolean }>(result, 'Customer');
  };

  let customers: Array<{ Id: string; DisplayName: string; Active?: boolean }> = [];

  // Id-equality match first when the arg is Id-like (QB customer Ids are numeric strings).
  // Active in (true, false) so an explicitly-referenced Id resolves even if the customer is inactive.
  if (/^\d+$/.test(nameOrId)) {
    customers = await queryCustomers(`Id = '${escapeQbValue(nameOrId)}' and Active in (true, false)`);
  }

  // Exact active DisplayName match.
  if (customers.length === 0) {
    customers = await queryCustomers(`DisplayName = '${escapeQbValue(nameOrId)}' and Active = true`);
  }

  // Partial (LIKE) active DisplayName match — first result wins.
  if (customers.length === 0) {
    customers = await queryCustomers(`DisplayName like '%${escapeQbValue(nameOrId)}%' and Active = true`);
  }

  if (customers.length === 0) {
    throw new Error(`Customer not found: "${nameOrId}". Try using the exact customer display name or ID.`);
  }

  // Use first match and cache it
  const customer = customers[0];
  const entry: CachedCustomer = {
    Id: customer.Id,
    DisplayName: customer.DisplayName,
    Active: customer.Active,
    fetchedAt: Date.now(),
  };
  customerCacheById.set(customer.Id, entry);
  customerCacheByName.set(customer.DisplayName.toLowerCase(), entry);

  return { value: customer.Id, name: customer.DisplayName };
}
