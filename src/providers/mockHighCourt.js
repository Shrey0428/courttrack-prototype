const BaseProvider = require('./base');

class MockHighCourtProvider extends BaseProvider {
  constructor() {
    super('mockHighCourt');
  }

  async fetchCase({ cnrNumber, caseLookup }) {
    const key = cnrNumber || caseLookup || 'UNKNOWN';
    const now = new Date();
    const d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const nextHearingDate = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

    return {
      source: this.name,
      courtName: key.startsWith('DLHC') ? 'High Court of Delhi' : 'Mock High Court',
      caseNumber: key,
      cnrNumber: key.length === 16 ? key : '',
      caseTitle: `Demo Matter for ${key}`,
      nextHearingDate,
      courtNumber: key.startsWith('DLHC') ? '12' : '3',
      caseStatus: 'Listed',
      lastOrderDate: '',
      officialSourceUrl: 'https://example.com/mock-court',
      rawMetadata: { mode: 'mock' }
    };
  }
}

module.exports = new MockHighCourtProvider();
