const DISTRICT_SITES = [
  {
    slug: 'central',
    label: 'Central District',
    url: 'https://centraldelhi.dcourts.gov.in/case-status-search-by-case-number/',
    complexes: [
      { value: 'DLCT11,DLCT12,DLCT13', text: 'Rouse Avenue Court Complex' },
      { value: 'DLCT01,DLCT02,DLCT03,DLCT04,DLCT05', text: 'Tis Hazari Court Complex' }
    ]
  },
  {
    slug: 'west',
    label: 'West District',
    url: 'https://westdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    complexes: [
      { value: 'DLWT01,DLWT02,DLWT03,DLWT04', text: 'Tis Hazari Court Complex' }
    ]
  },
  {
    slug: 'southwest',
    label: 'South West District',
    url: 'https://southwestdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    complexes: [
      { value: 'DLSW01,DLSW02,DLSW03,DLSW04,DLSW06', text: 'Dwarka Court Complex' }
    ]
  },
  {
    slug: 'east',
    label: 'East District',
    url: 'https://eastdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    complexes: [
      { value: 'DLET01,DLET02,DLET03,DLET04,DLET05', text: 'Karkardooma Court Complex' }
    ]
  },
  {
    slug: 'northeast',
    label: 'North East District',
    url: 'https://northeast.dcourts.gov.in/case-status-search-by-case-number/',
    complexes: [
      { value: 'DLNE01,DLNE02,DLNE03,DLNE04', text: 'Karkardooma Court Complex' }
    ]
  },
  {
    slug: 'shahdara',
    label: 'Shahdara District',
    url: 'https://shahdara.dcourts.gov.in/case-status-search-by-case-number/',
    complexes: [
      { value: 'DLSH01,DLSH02,DLSH03,DLSH04,DLSH05', text: 'Karkardooma Court Complex' }
    ]
  },
  {
    slug: 'newdelhi',
    label: 'New Delhi District',
    url: 'https://newdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    complexes: [
      { value: 'DLND01,DLND02,DLND03,DLND04', text: 'Patiala House Court Complex' }
    ]
  },
  {
    slug: 'north',
    label: 'North District',
    url: 'https://northdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    complexes: [
      { value: 'DLNT01,DLNT02,DLNT03,DLNT04', text: 'Rohini Court Complex' }
    ]
  },
  {
    slug: 'northwest',
    label: 'North West District',
    url: 'https://rohini.dcourts.gov.in/case-status-search-by-case-number/',
    complexes: [
      { value: 'DLNW01,DLNW02,DLNW03,DLNW04', text: 'Rohini Court Complex' }
    ]
  },
  {
    slug: 'south',
    label: 'South District',
    url: 'https://southdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    complexes: [
      { value: 'DLST01,DLST02,DLST03,DLST04', text: 'Saket Court Complex' }
    ]
  },
  {
    slug: 'southeast',
    label: 'South East District',
    url: 'https://southeastdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    complexes: [
      { value: 'DLSE01,DLSE02,DLSE03,DLSE04', text: 'Saket Court Complex' }
    ]
  }
];

function listDelhiDistrictSites() {
  return DISTRICT_SITES.map((site) => ({ ...site }));
}

function getDelhiDistrictSite(slug) {
  return DISTRICT_SITES.find((site) => site.slug === String(slug || '').trim()) || null;
}

module.exports = {
  listDelhiDistrictSites,
  getDelhiDistrictSite
};
