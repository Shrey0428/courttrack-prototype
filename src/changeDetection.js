function detectEvents(previous, current) {
  const events = [];

  if (!previous && current.nextHearingDate) {
    events.push({
      type: 'hearing_date_added',
      message: `Initial hearing date captured: ${current.nextHearingDate}`
    });
  }

  if (previous?.nextHearingDate !== current.nextHearingDate && previous?.nextHearingDate && current.nextHearingDate) {
    events.push({
      type: 'hearing_date_changed',
      message: `Hearing date changed from ${previous.nextHearingDate} to ${current.nextHearingDate}`
    });
  }

  if (previous?.caseStatus !== current.caseStatus && previous?.caseStatus && current.caseStatus) {
    events.push({
      type: 'case_status_changed',
      message: `Case status changed from ${previous.caseStatus} to ${current.caseStatus}`
    });
  }

  if (previous?.courtNumber !== current.courtNumber && previous?.courtNumber && current.courtNumber) {
    events.push({
      type: 'court_number_changed',
      message: `Court number changed from ${previous.courtNumber} to ${current.courtNumber}`
    });
  }

  const previousHistory = normalizeCaseHistory(previous?.caseHistory);
  const currentHistory = normalizeCaseHistory(current?.caseHistory);

  const newFilings = diffEntries(previousHistory.filings, currentHistory.filings, filingKey);
  if (newFilings.length) {
    events.push({
      type: 'filing_added',
      message: `${newFilings.length} new filing${newFilings.length === 1 ? '' : 's'} detected`,
      details: {
        items: newFilings
      }
    });
  }

  const newListings = diffEntries(previousHistory.listings, currentHistory.listings, listingKey);
  if (newListings.length) {
    events.push({
      type: 'listing_added',
      message: `${newListings.length} new listing${newListings.length === 1 ? '' : 's'} detected`,
      details: {
        items: newListings
      }
    });
  }

  const newOrders = diffEntries(previousHistory.orders, currentHistory.orders, orderKey);
  if (newOrders.length) {
    events.push({
      type: 'order_added',
      message: `${newOrders.length} new order${newOrders.length === 1 ? '' : 's'} detected`,
      details: {
        items: newOrders
      }
    });
  } else if (previous?.latestOrderDate !== current.latestOrderDate && previous?.latestOrderDate && current.latestOrderDate) {
    events.push({
      type: 'latest_order_uploaded',
      message: `A newer order was detected: ${current.latestOrderDate}`
    });

    if (
      current?.rawMetadata?.orderMonitor &&
      current.rawMetadata.orderMonitor.usedLatestOrderFallback === false &&
      current.rawMetadata.orderMonitor.latestOrderUrl
    ) {
      events.push({
        type: 'latest_order_checked_no_future_date',
        message: `Latest order dated ${current.latestOrderDate} was checked, but no future hearing date could be extracted`
      });
    }
  }

  return events;
}

function normalizeCaseHistory(caseHistory) {
  return {
    filings: Array.isArray(caseHistory?.filings) ? caseHistory.filings : [],
    listings: Array.isArray(caseHistory?.listings) ? caseHistory.listings : [],
    orders: Array.isArray(caseHistory?.orders) ? caseHistory.orders : []
  };
}

function diffEntries(previousEntries, currentEntries, keyBuilder) {
  if (!Array.isArray(previousEntries) || !Array.isArray(currentEntries) || !previousEntries.length || !currentEntries.length) {
    return [];
  }

  const seen = new Set(previousEntries.map((entry) => keyBuilder(entry)).filter(Boolean));
  return currentEntries.filter((entry) => {
    const key = keyBuilder(entry);
    return key && !seen.has(key);
  });
}

function filingKey(entry) {
  return normalizeKey([
    entry?.serialNumber,
    entry?.date,
    entry?.details,
    entry?.diaryNumber,
    entry?.status
  ]);
}

function listingKey(entry) {
  return normalizeKey([
    entry?.serialNumber,
    entry?.date,
    entry?.details,
    entry?.orderUrl
  ]);
}

function orderKey(entry) {
  return normalizeKey([
    entry?.serialNumber,
    entry?.date,
    entry?.details,
    entry?.url,
    entry?.sourceUrl
  ]);
}

function normalizeKey(parts) {
  return parts
    .map((part) => String(part || '').trim().toLowerCase())
    .filter(Boolean)
    .join('|');
}

module.exports = { detectEvents };
