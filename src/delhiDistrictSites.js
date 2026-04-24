const DISTRICT_SITES = [
  {
    slug: 'central',
    label: 'Central District',
    url: 'https://centraldelhi.dcourts.gov.in/case-status-search-by-case-number/',
    courtComplexes: [
      { label: 'Rouse Avenue Court Complex', value: 'DLCT11,DLCT12,DLCT13' },
      { label: 'Tis Hazari Court Complex', value: 'DLCT01,DLCT02,DLCT03,DLCT04,DLCT05' }
    ]
  },
  {
    slug: 'west',
    label: 'West District',
    url: 'https://westdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    courtComplexes: [
      { label: 'Tis Hazari Court Complex', value: 'DLWT01,DLWT02,DLWT03,DLWT04' }
    ]
  },
  {
    slug: 'southwest',
    label: 'South West District',
    url: 'https://southwestdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    courtComplexes: [
      { label: 'Dwarka Court Complex', value: 'DLSW01,DLSW02,DLSW03,DLSW04,DLSW06' }
    ]
  },
  {
    slug: 'east',
    label: 'East District',
    url: 'https://eastdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    courtComplexes: [
      { label: 'Karkardooma Court Complex', value: 'DLET01,DLET02,DLET03,DLET04,DLET05' }
    ]
  },
  {
    slug: 'northeast',
    label: 'North East District',
    url: 'https://northeast.dcourts.gov.in/case-status-search-by-case-number/',
    courtComplexes: [
      { label: 'Karkardooma Court Complex', value: 'DLNE01,DLNE02,DLNE03,DLNE04' }
    ]
  },
  {
    slug: 'shahdara',
    label: 'Shahdara District',
    url: 'https://shahdara.dcourts.gov.in/case-status-search-by-case-number/',
    courtComplexes: [
      { label: 'Karkardooma Court Complex', value: 'DLSH01,DLSH02,DLSH03,DLSH04,DLSH05' }
    ]
  },
  {
    slug: 'newdelhi',
    label: 'New Delhi District',
    url: 'https://newdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    courtComplexes: [
      { label: 'Patiala House Court Complex', value: 'DLND01,DLND02,DLND03,DLND04' }
    ]
  },
  {
    slug: 'north',
    label: 'North District',
    url: 'https://northdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    courtComplexes: [
      { label: 'Rohini Court Complex', value: 'DLNT01,DLNT02,DLNT03,DLNT04' }
    ]
  },
  {
    slug: 'rohini',
    label: 'North West District',
    url: 'https://rohini.dcourts.gov.in/case-status-search-by-case-number/',
    courtComplexes: [
      { label: 'Rohini Court Complex', value: 'DLNW01,DLNW02,DLNW03,DLNW04' }
    ]
  },
  {
    slug: 'south',
    label: 'South District',
    url: 'https://southdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    courtComplexes: [
      { label: 'Saket Court Complex', value: 'DLST01,DLST02,DLST03,DLST04' }
    ]
  },
  {
    slug: 'southeast',
    label: 'South East District',
    url: 'https://southeastdelhi.dcourts.gov.in/case-status-search-by-case-number/',
    courtComplexes: [
      { label: 'Saket Court Complex', value: 'DLSE01,DLSE02,DLSE03,DLSE04' }
    ]
  }
];

function listDelhiDistrictSites() {
  return DISTRICT_SITES.map((site) => ({
    slug: site.slug,
    label: site.label,
    url: site.url,
    courtComplexes: site.courtComplexes.map((complex) => ({ ...complex }))
  }));
}

function getDelhiDistrictSite(slug) {
  return DISTRICT_SITES.find((site) => site.slug === String(slug || '').trim()) || null;
}

module.exports = {
  listDelhiDistrictSites,
  getDelhiDistrictSite
};
