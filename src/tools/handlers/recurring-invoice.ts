// Handler for create_recurring_invoice tool

import QuickBooks from "node-quickbooks";
import axios from "axios";
import { randomUUID } from "crypto";
import {
  promisify,
  getDepartmentCache,
  resolveItem,
  resolveCustomer,
  clearCredentialsCache,
  getClient,
} from "../../client/index.js";
import { validateAmount, toDollars, formatDollars, sumCents } from "../../utils/index.js";

interface RecurringInvoiceLine {
  item_name?: string;
  item_id?: string;
  amount?: number;
  qty?: number;
  unit_price?: number;
  description?: string;
}

interface ScheduleInfo {
  start_date: string;
  end_date?: string;
  max_occurrences?: number;
  interval_type: "Daily" | "Weekly" | "Monthly" | "Yearly";
  num_interval?: number;
  day_of_week?: number;
  day_of_month?: number;
  days_before?: number;
}

export async function handleCreateRecurringInvoice(
  client: QuickBooks,
  args: {
    name: string;
    recur_type?: "Automated" | "Reminder" | "Unscheduled";
    customer_name?: string;
    customer_id?: string;
    department_name?: string;
    department_id?: string;
    memo?: string;
    customer_memo?: string;
    bill_email?: string;
    sales_term_ref?: string;
    schedule_info: ScheduleInfo;
    lines: RecurringInvoiceLine[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    name,
    recur_type = "Automated",
    customer_name,
    customer_id,
    department_name,
    department_id,
    memo,
    customer_memo,
    bill_email,
    sales_term_ref,
    schedule_info,
    lines,
    draft = true,
  } = args;

  // Validate required fields
  if (!name) {
    throw new Error("Template name is required");
  }
  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }
  if (!schedule_info || !schedule_info.start_date || !schedule_info.interval_type) {
    throw new Error("schedule_info with start_date and interval_type is required");
  }

  // Validate schedule field mutual exclusions
  if (schedule_info.end_date && schedule_info.max_occurrences) {
    throw new Error("Cannot specify both end_date and max_occurrences - they are mutually exclusive");
  }
  if (schedule_info.day_of_week !== undefined && schedule_info.interval_type !== "Weekly") {
    throw new Error("day_of_week is only valid when interval_type is 'Weekly'");
  }
  if (schedule_info.day_of_month !== undefined && schedule_info.interval_type !== "Monthly") {
    throw new Error("day_of_month is only valid when interval_type is 'Monthly'");
  }
  if (schedule_info.days_before !== undefined && recur_type !== "Automated") {
    throw new Error("days_before is only valid when recur_type is 'Automated'");
  }

  // Resolve customer
  if (!customer_id && !customer_name) {
    throw new Error("Either customer_name or customer_id is required");
  }
  let customerRef: { value: string; name: string };
  if (customer_id) {
    customerRef = await resolveCustomer(client, customer_id);
  } else {
    customerRef = await resolveCustomer(client, customer_name!);
  }

  // Resolve department (optional)
  let departmentRef: { value: string; name: string } | undefined;
  const deptInput = department_id || department_name;
  if (deptInput) {
    const deptCache = await getDepartmentCache(client);
    const byId = deptCache.byId.get(deptInput);
    if (byId) {
      departmentRef = { value: byId.Id, name: byId.FullyQualifiedName || byId.Name };
    } else {
      const byName = deptCache.byName.get(deptInput.toLowerCase());
      if (byName) {
        departmentRef = { value: byName.Id, name: byName.FullyQualifiedName || byName.Name };
      } else {
        const byPartial = deptCache.items.find(d =>
          d.FullyQualifiedName?.toLowerCase().includes(deptInput.toLowerCase())
        );
        if (byPartial) {
          departmentRef = { value: byPartial.Id, name: byPartial.FullyQualifiedName || byPartial.Name };
        } else {
          throw new Error(`Department not found: "${deptInput}"`);
        }
      }
    }
  }

  // Resolve sales term (optional)
  let salesTermRef: { value: string; name: string } | undefined;
  if (sales_term_ref) {
    const terms = await promisify<{ QueryResponse: { Term?: Array<{ Id: string; Name: string }> } }>((cb) =>
      (client as unknown as Record<string, Function>).findTerms(cb)
    );
    const termList = terms.QueryResponse?.Term || [];
    const match = termList.find(t =>
      t.Name.toLowerCase() === sales_term_ref.toLowerCase() ||
      t.Id === sales_term_ref
    );
    if (!match) {
      const available = termList.map(t => t.Name).join(', ');
      throw new Error(`Term not found: "${sales_term_ref}". Available: ${available}`);
    }
    salesTermRef = { value: match.Id, name: match.Name };
  }

  // Resolve lines
  const resolvedLines = await Promise.all(lines.map(async (line) => {
    const itemInput = line.item_name || line.item_id;
    if (!itemInput) {
      throw new Error("Each line must have either item_name or item_id");
    }
    if (line.amount === undefined && (line.qty === undefined || line.unit_price === undefined)) {
      throw new Error(`Line for "${itemInput}" requires amount, or both qty and unit_price`);
    }

    const itemRef = await resolveItem(client, itemInput);

    const qty = line.qty ?? 1;
    let amountCents: number;
    let unitPriceDollars: number;

    if (line.amount !== undefined) {
      amountCents = validateAmount(line.amount, `Line for ${itemRef.name}`);
      unitPriceDollars = toDollars(amountCents) / qty;
    } else {
      const upCents = validateAmount(line.unit_price!, `Line unit_price for ${itemRef.name}`);
      unitPriceDollars = toDollars(upCents);
      amountCents = upCents * qty;
    }

    return {
      itemRef,
      qty,
      unitPriceDollars,
      amountCents,
      amountDollars: toDollars(amountCents),
      description: line.description,
    };
  }));

  // Calculate total
  const totalCents = sumCents(resolvedLines.map(l => l.amountCents));

  // Build RecurringInfo
  const recurringInfo: Record<string, unknown> = {
    Name: name,
    RecurType: recur_type,
    Active: true,
    ScheduleInfo: {
      StartDate: schedule_info.start_date,
      IntervalType: schedule_info.interval_type,
      NumInterval: schedule_info.num_interval ?? 1,
      ...(schedule_info.end_date && { EndDate: schedule_info.end_date }),
      ...(schedule_info.max_occurrences && { MaxOccurrences: schedule_info.max_occurrences }),
      ...(schedule_info.day_of_week !== undefined && { DayOfWeek: schedule_info.day_of_week }),
      ...(schedule_info.day_of_month !== undefined && { DayOfMonth: schedule_info.day_of_month }),
      ...(schedule_info.days_before !== undefined && { DaysBefore: schedule_info.days_before }),
    },
  };

  // Build Invoice template
  const invoiceTemplate: Record<string, unknown> = {
    CustomerRef: customerRef,
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(salesTermRef && { SalesTermRef: salesTermRef }),
    ...(memo && { PrivateNote: memo }),
    ...(customer_memo && { CustomerMemo: { value: customer_memo } }),
    ...(bill_email && { BillEmail: { Address: bill_email } }),
    Line: resolvedLines.map((line) => ({
      Amount: line.amountDollars,
      DetailType: "SalesItemLineDetail",
      ...(line.description && { Description: line.description }),
      SalesItemLineDetail: {
        ItemRef: line.itemRef,
        Qty: line.qty,
        UnitPrice: line.unitPriceDollars,
      },
    })),
  };

  // Build the full RecurringTransaction object
  // The Invoice object contains RecurringInfo as a nested property
  const recurringTxn = {
    Invoice: {
      ...invoiceTemplate,
      RecurringInfo: recurringInfo,
    },
  };

  if (draft) {
    const scheduleDesc = `${schedule_info.interval_type} starting ${schedule_info.start_date}` +
      (schedule_info.max_occurrences ? `, ${schedule_info.max_occurrences} occurrences` : '') +
      (schedule_info.end_date ? `, ending ${schedule_info.end_date}` : '');

    const preview = [
      "DRAFT - Recurring Invoice Preview",
      "",
      `Template Name: ${name}`,
      `Type: ${recur_type}`,
      `Schedule: ${scheduleDesc}`,
      "",
      `Customer: ${customerRef.name}`,
      `Terms: ${salesTermRef?.name || "(none)"}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `Memo: ${memo || "(none)"}`,
      `Customer Memo: ${customer_memo || "(none)"}`,
      `Bill Email: ${bill_email || "(none)"}`,
      `Total per invoice: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l =>
        `  ${l.itemRef.name}: Qty ${l.qty} × $${l.unitPriceDollars.toFixed(2)} = $${l.amountDollars.toFixed(2)}${l.description ? ` "${l.description}"` : ""}`
      ),
      "",
      "Set draft=false to create this recurring invoice.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Make the API call with retry for auth errors
  const makeApiCall = async (retryOnAuth = true): Promise<unknown> => {
    const qbClient = client as unknown as {
      endpoint: string;
      realmId: string;
      token: string;
      minorversion: number;
    };

    const url = `${qbClient.endpoint}${qbClient.realmId}/recurringtransaction?minorversion=${qbClient.minorversion || 75}`;

    try {
      const response = await axios.post(url, recurringTxn, {
        headers: {
          'Authorization': `Bearer ${qbClient.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Encoding': 'identity',
          'Request-Id': randomUUID(),
        },
        decompress: false,
      });
      return response.data;
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        // Check for auth error and retry once
        if (retryOnAuth && error.response?.status === 401) {
          clearCredentialsCache();
          const freshClient = await getClient();
          const freshQbClient = freshClient as unknown as typeof qbClient;

          const retryResponse = await axios.post(
            `${freshQbClient.endpoint}${freshQbClient.realmId}/recurringtransaction?minorversion=${freshQbClient.minorversion || 75}`,
            recurringTxn,
            {
              headers: {
                'Authorization': `Bearer ${freshQbClient.token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Accept-Encoding': 'identity',
                'Request-Id': randomUUID(),
              },
              decompress: false,
            }
          );
          return retryResponse.data;
        }

        // Format error for MCP response
        const errData = error.response?.data;
        const errMsg = errData?.Fault?.Error?.[0]?.Detail ||
                       errData?.Fault?.Error?.[0]?.Message ||
                       error.message;
        // Include full error for debugging
        console.error('QB API Error:', JSON.stringify(errData, null, 2));
        throw new Error(`QuickBooks API error: ${errMsg}`);
      }
      throw error;
    }
  };

  const result = await makeApiCall() as {
    RecurringTransaction?: {
      Invoice?: { RecurDataRef?: { value: string } };
    };
  };

  const templateId = result.RecurringTransaction?.Invoice?.RecurDataRef?.value;
  const qboUrl = templateId
    ? `https://app.qbo.intuit.com/app/recurringtransaction?txnId=${templateId}`
    : "https://app.qbo.intuit.com/app/recurringtransactions";

  const response = [
    "Recurring Invoice Created!",
    "",
    `Template Name: ${name}`,
    `Type: ${recur_type}`,
    `Customer: ${customerRef.name}`,
    `Schedule: ${schedule_info.interval_type} starting ${schedule_info.start_date}`,
    `Total per invoice: $${formatDollars(totalCents)}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return {
    content: [{ type: "text", text: response }],
  };
}
