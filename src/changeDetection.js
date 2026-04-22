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

  return events;
}

module.exports = { detectEvents };
