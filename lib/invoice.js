/**
 * Calculates GST totals for an invoice
 * @param {number} quantity - Quantity of items
 * @param {number} rate - Rate per item
 * @param {number} discount - Discount amount (default: 0)
 * @param {boolean} isInterState - Whether it's an inter-state transaction (default: false)
 * @param {number} gstPercentage - GST percentage (default: 18)
 * @returns {object} - Object containing grossAmount, taxableAmount, sgst, cgst, igst, roundOff, total
 */
export function calculateTotals(
  quantity,
  rate,
  discount = 0,
  isInterState = false,
  gstPercentage = 18
) {
  const grossAmount = quantity * rate;
  const taxableAmount = grossAmount - discount;

  // Convert GST percentage to decimal (e.g., 18 -> 0.18)
  const gstRate = gstPercentage / 100;

  let sgst = 0;
  let cgst = 0;
  let igst = 0;

  if (isInterState) {
    // Inter-state: Use IGST (full GST rate)
    igst = taxableAmount * gstRate;
  } else {
    // Intra-state: Use SGST + CGST (half each)
    sgst = taxableAmount * (gstRate / 2);
    cgst = taxableAmount * (gstRate / 2);
  }

  const subtotal = taxableAmount + sgst + cgst + igst;
  const total = Math.round(subtotal);
  const roundOff = total - subtotal;

  return { grossAmount, taxableAmount, sgst, cgst, igst, roundOff, total };
}

/**
 * Formats a number as Indian Rupees (INR)
 * @param {number} amount - Amount to format
 * @returns {string} - Formatted INR string
 */
export function formatINR(amount) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Gets the current financial year range
 * @param {Date} date - Date to calculate from (default: current date)
 * @returns {string} - Financial year in format "YYYY-YY"
 */
export function currentFinancialYearRange(date = new Date()) {
  const financialYearStart = new Date(date.getFullYear(), 3, 1);
  const fyStart =
    date >= financialYearStart ? date.getFullYear() : date.getFullYear() - 1;
  const fyEnd = (fyStart + 1).toString().slice(-2);
  return `${fyStart}-${fyEnd}`;
}

/**
 * Converts a number to words (for Indian currency)
 * @param {number} num - Number to convert
 * @returns {string} - Number in words
 */
export function numberToWords(num) {
  if (num === 0) return "Zero";

  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];

  function convertHundreds(n) {
    let result = "";
    if (n >= 100) {
      result += ones[Math.floor(n / 100)] + " Hundred ";
      n %= 100;
    }
    if (n >= 20) {
      result += tens[Math.floor(n / 10)] + " ";
      n %= 10;
    }
    if (n > 0) {
      result += ones[n] + " ";
    }
    return result;
  }

  const crores = Math.floor(num / 10000000);
  const lakhs = Math.floor((num % 10000000) / 100000);
  const thousands = Math.floor((num % 100000) / 1000);
  const hundreds = num % 1000;

  let result = "";
  if (crores > 0) result += convertHundreds(crores) + "Crore ";
  if (lakhs > 0) result += convertHundreds(lakhs) + "Lakh ";
  if (thousands > 0) result += convertHundreds(thousands) + "Thousand ";
  if (hundreds > 0) result += convertHundreds(hundreds);

  return result.trim();
}

/**
 * Extracts state code from GSTIN
 * GSTIN format: 22AAAAA0000A1Z5 (first 2 digits are state code)
 * @param {string} gstin - GSTIN number
 * @returns {string} - State code (default: "33" if invalid)
 */
export function getStateCodeFromGSTIN(gstin) {
  if (!gstin || gstin.length < 2) return "33"; // Default to Tamil Nadu
  return gstin.substring(0, 2);
}

/**
 * Determines if transaction is inter-state based on customer and unit state codes
 * @param {string} customerGstin - Customer's GSTIN
 * @param {string} unitStateCode - Unit's state code (default: "33")
 * @returns {boolean} - True if inter-state transaction
 */
export function isInterStateTransaction(customerGstin, unitStateCode = "33") {
  const customerStateCode = getStateCodeFromGSTIN(customerGstin);
  return customerStateCode !== unitStateCode;
}

/**
 * Splits an address string into two lines
 * If address length exceeds 140 characters, splits based on comma or space
 * Otherwise handles newlines, commas, and other delimiters
 * @param {string} address - Address string to split
 * @returns {object} - Object with line1 and line2 properties
 */
export function splitAddress(address) {
  if (!address) return { line1: "", line2: "" };

  // If address length is 140 or less, return as single line
  if (address.length <= 140) {
    return { line1: address, line2: "" };
  }

  // Address exceeds 140 characters, need to split
  // Try splitting by newline first
  if (address.includes("\n")) {
    const parts = address.split("\n").filter((p) => p.trim());
    return {
      line1: parts[0] || "",
      line2: parts.slice(1).join(", ") || "",
    };
  }

  // Try splitting by comma
  if (address.includes(",")) {
    const parts = address
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p);

    // Find optimal split point to keep line1 under 140 chars
    let line1Parts = [];
    let line2Parts = [];
    let currentLength = 0;

    for (let i = 0; i < parts.length; i++) {
      const partWithComma = i === 0 ? parts[i] : "," + parts[i];
      if (
        currentLength + partWithComma.length <= 140 &&
        line2Parts.length === 0
      ) {
        line1Parts.push(parts[i]);
        currentLength += partWithComma.length;
      } else {
        line2Parts.push(parts[i]);
      }
    }

    return {
      line1: line1Parts.join(",") || "",
      line2: line2Parts.join(",") || "",
    };
  }

  // Try splitting by space if no commas
  if (address.includes(" ")) {
    const parts = address.split(" ").filter((p) => p.trim());

    let line1Parts = [];
    let line2Parts = [];
    let currentLength = 0;

    for (let i = 0; i < parts.length; i++) {
      const partWithSpace = i === 0 ? parts[i] : " " + parts[i];
      if (
        currentLength + partWithSpace.length <= 140 &&
        line2Parts.length === 0
      ) {
        line1Parts.push(parts[i]);
        currentLength += partWithSpace.length;
      } else {
        line2Parts.push(parts[i]);
      }
    }

    return {
      line1: line1Parts.join(" ") || "",
      line2: line2Parts.join(" ") || "",
    };
  }

  // If no delimiter and exceeds 140, split at 140 characters
  return {
    line1: address.substring(0, 140),
    line2: address.substring(140),
  };
}

/**
 * Rounds a number to exactly 2 decimal places
 * @param {number} num - Number to round
 * @returns {number} - Rounded number
 */
function round2(num) {
  return Math.round(num * 100) / 100;
}

/**
 * Converts invoice number from U-15/0009/2025-26 format to INV-2025-11-0009 format
 * Example: U-15/0009/2025-26 -> INV-2025-11-0009
 * @param {string} invoiceNo - Original invoice number
 * @param {Date} invoiceDate - Invoice date
 * @returns {string} - Formatted invoice number
 */
function convertInvoiceNumber(invoiceNo, invoiceDate) {
  // Extract the sequence number from the invoice number (e.g., "0009" from "U-15/0009/2025-26")
  const match = invoiceNo.match(/\/(\d+)\//);
  const sequenceNumber = match ? match[1] : "0001";

  // Format: INV-YYYY-MM-XXXX
  const year = invoiceDate.getFullYear();
  const month = String(invoiceDate.getMonth() + 1).padStart(2, "0");

  return `INV-${year}-${month}-${sequenceNumber}`;
}

/**
 * Generates GST E-Invoice JSONB structure from invoice parameters
 * @param {object} params - Invoice parameters object
 * @returns {object} - GST E-Invoice JSONB structure
 */
export function generateInvoiceJSONB(params) {
  const {
    invoiceNo,
    invoiceDate,
    customerGstin,
    customerName,
    customerTradeName,
    customerType,
    billingAddress,
    customerLoc,
    customerPin,
    customerStateCode,
    deliveryAddress,
    deliveryLoc,
    deliveryPin,
    unitAddress,
    unitLoc,
    unitPincode,
    unitStateCode,
    grade,
    productDesc,
    isServc,
    hsnCode,
    quantity,
    rate,
    grossAmount,
    discount,
    taxableAmount,
    cgst,
    sgst,
    igst,
    roundOff,
    total,
    gstPercentage,
  } = params;

  // Convert invoice number to INV-YYYY-MM-XXXX format
  const formattedInvoiceNo = convertInvoiceNumber(invoiceNo, invoiceDate);

  // Format date as DD/MM/YYYY
  const formattedDate = `${String(invoiceDate.getDate()).padStart(
    2,
    "0"
  )}/${String(invoiceDate.getMonth() + 1).padStart(
    2,
    "0"
  )}/${invoiceDate.getFullYear()}`;

  // Split addresses
  const billingAddr = splitAddress(billingAddress);
  const deliveryAddr = splitAddress(deliveryAddress);
  const unitAddr = splitAddress(unitAddress || "");

  // Use customer name as trade name if not provided
  const tradeName = customerTradeName || customerName;

  // Round all amounts to 2 decimal places
  const roundedGrossAmount = round2(grossAmount);
  const roundedDiscount = round2(discount);
  const roundedTaxableAmount = round2(taxableAmount);
  const roundedCgst = round2(cgst);
  const roundedSgst = round2(sgst);
  const roundedIgst = round2(igst);
  const roundedRoundOff = round2(roundOff);
  const roundedTotal = round2(total);
  const roundedRate = round2(rate);
  const roundedQuantity = round2(quantity);

  return {
    Version: "1.1",
    Irn: null,
    TranDtls: {
      TaxSch: "GST",
      SupTyp: customerType,
      RegRev: "N",
      EcmGstin: null,
      IgstOnIntra: "N",
    },
    DocDtls: {
      Typ: "INV",
      No: invoiceNo,
      Dt: formattedDate,
    },
    SellerDtls: {
      Gstin: "33AATCA4851H1ZH",
      LglNm: "AAROV BUILDMART PRIVATE LIMITED",
      TrdNm: "AAROV BUILDMART PRIVATE LIMITED",
      Addr1: "No 1, B, floor- Office No 4 Second Floor",
      Addr2: "Narasimhan Road 3rd Street",
      Loc: "Chennai",
      Pin: 600017,
      Stcd: "33",
    },
    BuyerDtls: {
      Gstin: customerGstin,
      LglNm: customerName,
      TrdNm: tradeName,
      Pos: customerStateCode,
      Addr1: billingAddr.line1,
      ...(billingAddr.line2 && { Addr2: billingAddr.line2 }),
      Loc: customerLoc || "",
      Pin: parseInt(customerPin || "0"),
      Stcd: customerStateCode,
    },
    ItemList: [
      {
        SlNo: "1",
        PrdDesc: productDesc,
        IsServc: isServc,
        HsnCd: hsnCode,
        Qty: roundedQuantity,
        Unit: "CBM",
        UnitPrice: roundedRate,
        TotAmt: roundedGrossAmount,
        Discount: roundedDiscount,
        AssAmt: roundedTaxableAmount,
        GstRt: gstPercentage, // Use dynamic GST percentage
        IgstAmt: roundedIgst,
        CgstAmt: roundedCgst,
        SgstAmt: roundedSgst,
        TotItemVal: roundedTotal,
      },
    ],
    ValDtls: {
      AssVal: roundedTaxableAmount,
      CgstVal: roundedCgst,
      SgstVal: roundedSgst,
      IgstVal: roundedIgst,
      CesVal: 0.0,
      StCesVal: 0.0,
      Discount: roundedDiscount,
      OthChrg: 0.0,
      RndOffAmt: roundedRoundOff,
      TotInvVal: roundedTotal,
      TotInvValFc: roundedTotal,
    },
    DispDtls: {
      Nm: "AAROV BUILDMART PRIVATE LIMITED",
      Addr1: unitAddr.line1,
      ...(unitAddr.line2 && { Addr2: unitAddr.line2 }),
      Loc: unitLoc,
      Pin: parseInt(unitPincode),
      Stcd: "33",
    },
    ShipDtls: {
      Gstin: customerGstin,
      LglNm: customerName,
      TrdNm: tradeName,
      Addr1: deliveryAddr.line1,
      ...(deliveryAddr.line2 && { Addr2: deliveryAddr.line2 }),
      Loc: deliveryLoc || "",
      Pin: parseInt(deliveryPin || "0"),
      Stcd: "33",
    },
  };
}

/**
 * Converts credit note number from CN-15/0009/2025-26 format to CRN-2025-11-0009 format
 * Example: CN-15/0009/2025-26 -> CRN-2025-11-0009
 * @param {string} creditNoteNo - Original credit note number
 * @param {Date} creditNoteDate - Credit note date
 * @returns {string} - Formatted credit note number
 */
function convertCreditNoteNumber(creditNoteNo, creditNoteDate) {
  // Extract the sequence number from the credit note number (e.g., "0009" from "CN-15/0009/2025-26")
  const match = creditNoteNo.match(/\/(\d+)\//);
  const sequenceNumber = match ? match[1] : "0001";

  // Format: CRN-YYYY-MM-XXXX
  const year = creditNoteDate.getFullYear();
  const month = String(creditNoteDate.getMonth() + 1).padStart(2, "0");

  return `CRN-${year}-${month}-${sequenceNumber}`;
}

/**
 * Generates GST E-Invoice JSONB structure for Credit Note
 * Credit notes reference the original invoice and use document type "CRN"
 * @param {object} params - Credit note parameters object
 * @returns {object} - GST E-Invoice JSONB structure for credit note
 */
export function generateCreditNoteJSONB(params) {
  const {
    creditNoteNo,
    creditNoteDate,
    originalInvoiceNo,
    originalInvoiceDate,
    reasonForCreditNote,
    poNumber,
    customerGstin,
    customerName,
    customerTradeName,
    customerType,
    billingAddress,
    customerLoc,
    customerPin,
    customerStateCode,
    deliveryAddress,
    deliveryLoc,
    deliveryPin,
    unitAddress,
    unitLoc,
    unitPincode,
    unitStateCode,
    grade,
    productDesc,
    isServc,
    hsnCode,
    quantity,
    rate,
    grossAmount,
    discount,
    taxableAmount,
    cgst,
    sgst,
    igst,
    roundOff,
    total,
    gstPercentage,
  } = params;

  // Convert credit note number to CRN-YYYY-MM-XXXX format
  const formattedCreditNoteNo = convertCreditNoteNumber(
    creditNoteNo,
    creditNoteDate
  );

  // Format dates as DD/MM/YYYY
  const formattedCreditNoteDate = `${String(creditNoteDate.getDate()).padStart(
    2,
    "0"
  )}/${String(creditNoteDate.getMonth() + 1).padStart(
    2,
    "0"
  )}/${creditNoteDate.getFullYear()}`;

  const formattedOriginalInvoiceDate = `${String(
    originalInvoiceDate.getDate()
  ).padStart(2, "0")}/${String(originalInvoiceDate.getMonth() + 1).padStart(
    2,
    "0"
  )}/${originalInvoiceDate.getFullYear()}`;

  // Split addresses
  const billingAddr = splitAddress(billingAddress);
  const deliveryAddr = splitAddress(deliveryAddress);
  const unitAddr = splitAddress(unitAddress || "");

  // Use customer name as trade name if not provided
  const tradeName = customerTradeName || customerName;

  // Round all amounts to 2 decimal places
  const roundedGrossAmount = round2(grossAmount);
  const roundedDiscount = round2(discount);
  const roundedTaxableAmount = round2(taxableAmount);
  const roundedCgst = round2(cgst);
  const roundedSgst = round2(sgst);
  const roundedIgst = round2(igst);
  const roundedRoundOff = round2(roundOff);
  const roundedTotal = round2(total);
  const roundedRate = round2(rate);
  const roundedQuantity = round2(quantity);

  // Build the credit note JSONB (similar to invoice but with CRN type and reference details)
  const creditNote = {
    Version: "1.1",
    Irn: null,
    TranDtls: {
      TaxSch: "GST",
      SupTyp: customerType,
      RegRev: "N",
      EcmGstin: null,
      IgstOnIntra: "N",
    },
    DocDtls: {
      Typ: "CRN", // Credit Note type
      No: formattedCreditNoteNo,
      Dt: formattedCreditNoteDate,
    },
    SellerDtls: {
      Gstin: "33AATCA4851H1ZH",
      LglNm: "AAROV BUILDMART PRIVATE LIMITED",
      TrdNm: "AAROV BUILDMART PRIVATE LIMITED",
      Addr1: "No 1, B, floor- Office No 4 Second Floor",
      Addr2: "Narasimhan Road 3rd Street",
      Loc: "Chennai",
      Pin: 600017,
      Stcd: "33",
    },
    BuyerDtls: {
      Gstin: customerGstin,
      LglNm: customerName,
      TrdNm: tradeName,
      Pos: customerStateCode,
      Addr1: billingAddr.line1,
      ...(billingAddr.line2 && { Addr2: billingAddr.line2 }),
      Loc: customerLoc || "",
      Pin: parseInt(customerPin || "0"),
      Stcd: customerStateCode,
    },
    ItemList: [
      {
        SlNo: "1",
        PrdDesc: productDesc,
        IsServc: isServc,
        HsnCd: hsnCode,
        Qty: roundedQuantity,
        Unit: "CBM",
        UnitPrice: roundedRate,
        TotAmt: roundedGrossAmount,
        Discount: roundedDiscount,
        AssAmt: roundedTaxableAmount,
        GstRt: gstPercentage,
        IgstAmt: roundedIgst,
        CgstAmt: roundedCgst,
        SgstAmt: roundedSgst,
        TotItemVal: roundedTotal,
      },
    ],
    ValDtls: {
      AssVal: roundedTaxableAmount,
      CgstVal: roundedCgst,
      SgstVal: roundedSgst,
      IgstVal: roundedIgst,
      CesVal: 0.0,
      StCesVal: 0.0,
      Discount: roundedDiscount,
      OthChrg: 0.0,
      RndOffAmt: roundedRoundOff,
      TotInvVal: roundedTotal,
      TotInvValFc: roundedTotal,
    },
    DispDtls: {
      Nm: "AAROV BUILDMART PRIVATE LIMITED",
      Addr1: unitAddr.line1,
      ...(unitAddr.line2 && { Addr2: unitAddr.line2 }),
      Loc: unitLoc,
      Pin: parseInt(unitPincode),
      Stcd: "33",
    },
    ShipDtls: {
      Gstin: customerGstin,
      LglNm: customerName,
      TrdNm: tradeName,
      Addr1: deliveryAddr.line1,
      ...(deliveryAddr.line2 && { Addr2: deliveryAddr.line2 }),
      Loc: deliveryLoc || customerLoc || "Unknown",
      Pin: parseInt(deliveryPin || customerPin || "600001"),
      Stcd: customerStateCode,
    },
    // Credit Note specific: Reference to original invoice
    RefDtls: {
      InvRm: reasonForCreditNote,
      PrecDocDtls: [
        {
          InvNo: originalInvoiceNo,
          InvDt: formattedOriginalInvoiceDate,
          ...(poNumber && { OthRefNo: poNumber }),
        },
      ],
    },
  };

  return creditNote;
}
