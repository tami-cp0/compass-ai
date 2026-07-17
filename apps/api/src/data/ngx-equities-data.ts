// Canonical list of NGX-listed equities used by the lookupTicker helper.
// Compiled into the bundle so no runtime file I/O is needed.
//
// Sectors follow the OFFICIAL NGX industry classification (Agriculture,
// Conglomerates, Construction/Real Estate, Consumer Goods, Financial Services,
// Healthcare, ICT, Industrial Goods, Natural Resources, Oil and Gas, Services,
// Utilities). subSector is set where the NGX sub-sector is unambiguous —
// currently the Financial Services split (Banking / Insurance / Other
// Financial Institutions), which is how users actually talk.

export interface NgxEquity {
	ticker: string;
	company: string;
	sector: string;
	subSector?: string;
}

export const NGX_EQUITIES: readonly NgxEquity[] = [
	// ── Financial Services — Banking ──
	{ ticker: 'ACCESSCORP', company: 'Access Holdings Plc', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'ETI', company: 'Ecobank Transnational Incorporated', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'FBNH', company: 'FBN Holdings Plc', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'FCMB', company: 'FCMB Group Plc', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'FIDELITYBK', company: 'Fidelity Bank Plc', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'GTCO', company: 'Guaranty Trust Holding Company Plc', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'JAIZBANK', company: 'Jaiz Bank Plc', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'STANBIC', company: 'Stanbic IBTC Holdings Plc', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'STERLINGNG', company: 'Sterling Financial Holdings Company', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'UBA', company: 'United Bank for Africa Plc', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'UNITYBNK', company: 'Unity Bank Plc', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'WEMABANK', company: 'Wema Bank Plc', sector: 'Financial Services', subSector: 'Banking' },
	{ ticker: 'ZENITHBANK', company: 'Zenith Bank Plc', sector: 'Financial Services', subSector: 'Banking' },

	// ── Financial Services — Insurance ──
	{ ticker: 'AFRINSURE', company: 'African Alliance Insurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'AIICO', company: 'AIICO Insurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'CONHAL', company: 'Consolidated Hallmark Holdings Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'CORNERST', company: 'Cornerstone Insurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'CUSTODIAN', company: 'Custodian Investment Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'FTGINSURE', company: 'Fortis Insurance Services', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'INTENEGINS', company: 'International Energy Insurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'LASACO', company: 'Lasaco Assurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'LINKASSURE', company: 'Linkage Assurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'MANSARD', company: 'AXA Mansard Insurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'MUTUALBEN', company: 'Mutual Benefits Assurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'NEM', company: 'N.E.M. Insurance Company Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'PRESTIGE', company: 'Prestige Assurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'REGALINS', company: 'Regency Alliance Insurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'ROYALEX', company: 'Royal Exchange Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'SUNUASSUR', company: 'SUNU Assurances Nigeria Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'UNIVERSINS', company: 'Universal Insurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'VERITASKAP', company: 'Veritas Kapital Assurance Plc', sector: 'Financial Services', subSector: 'Insurance' },
	{ ticker: 'WAPIC', company: 'Coronation Insurance Plc', sector: 'Financial Services', subSector: 'Insurance' },

	// ── Financial Services — Other Financial Institutions ──
	{ ticker: 'ABBEYBDS', company: 'Abbey Mortgage Bank Plc', sector: 'Financial Services', subSector: 'Other Financial Institutions' },
	{ ticker: 'AFRIPRUD', company: 'Africa Prudential Plc', sector: 'Financial Services', subSector: 'Other Financial Institutions' },
	{ ticker: 'ASOSAVINGS', company: 'Aso Savings & Loans Plc', sector: 'Financial Services', subSector: 'Other Financial Institutions' },
	{ ticker: 'DEAPCAP', company: 'Deap Capital Management & Trust Plc', sector: 'Financial Services', subSector: 'Other Financial Institutions' },
	{ ticker: 'INFINITY', company: 'Infinity Trust Mortgage Bank Plc', sector: 'Financial Services', subSector: 'Other Financial Institutions' },
	{ ticker: 'NGXGROUP', company: 'Nigerian Exchange Group Plc', sector: 'Financial Services', subSector: 'Other Financial Institutions' },
	{ ticker: 'RESORTSAL', company: 'Resort Savings & Loans Plc', sector: 'Financial Services', subSector: 'Other Financial Institutions' },
	{ ticker: 'UCAP', company: 'United Capital Plc', sector: 'Financial Services', subSector: 'Other Financial Institutions' },
	{ ticker: 'UNIC', company: 'UNIC Diversified Holdings Plc', sector: 'Financial Services', subSector: 'Other Financial Institutions' },

	// ── Consumer Goods ──
	{ ticker: 'ANINO', company: 'Anino International Plc', sector: 'Consumer Goods' },
	{ ticker: 'BUAFOODS', company: 'BUA Foods Plc', sector: 'Consumer Goods' },
	{ ticker: 'CADBURY', company: 'Cadbury Nigeria Plc', sector: 'Consumer Goods' },
	{ ticker: 'CHAMPION', company: 'Champion Breweries Plc', sector: 'Consumer Goods' },
	{ ticker: 'DANGSUGAR', company: 'Dangote Sugar Refinery Plc', sector: 'Consumer Goods' },
	{ ticker: 'DNMEYER', company: 'Meyer Plc', sector: 'Consumer Goods' },
	{ ticker: 'DUNLOP', company: 'Dunlop Nigeria Plc', sector: 'Consumer Goods' },
	{ ticker: 'ENAMELWA', company: 'Nigerian Enamelware Plc', sector: 'Consumer Goods' },
	{ ticker: 'FLOURMILL', company: 'Flour Mills of Nigeria Plc', sector: 'Consumer Goods' },
	{ ticker: 'FOOTWEAR', company: 'Footwear Manufacture Nigeria Plc', sector: 'Consumer Goods' },
	{ ticker: 'GOLDBREW', company: 'Golden Guinea Breweries Plc', sector: 'Consumer Goods' },
	{ ticker: 'GUINNESS', company: 'Guinness Nigeria Plc', sector: 'Consumer Goods' },
	{ ticker: 'HONEYFLOUR', company: 'Honeywell Flour Mill Plc', sector: 'Consumer Goods' },
	{ ticker: 'INTBREW', company: 'International Breweries Plc', sector: 'Consumer Goods' },
	{ ticker: 'MCNICHOLS', company: 'McNichols Plc', sector: 'Consumer Goods' },
	{ ticker: 'MULTITREX', company: 'Multi-Trex Integrated Foods Plc', sector: 'Consumer Goods' },
	{ ticker: 'NASCON', company: 'NASCON Allied Industries Plc', sector: 'Consumer Goods' },
	{ ticker: 'NB', company: 'Nigerian Breweries Plc', sector: 'Consumer Goods' },
	{ ticker: 'NESTLE', company: 'Nestle Nigeria Plc', sector: 'Consumer Goods' },
	{ ticker: 'ROKANA', company: 'Rokana Industries Plc', sector: 'Consumer Goods' },
	{ ticker: 'UNILEVER', company: 'Unilever Nigeria Plc', sector: 'Consumer Goods' },
	{ ticker: 'VITAFOAM', company: 'Vitafoam Nigeria Plc', sector: 'Consumer Goods' },
	{ ticker: 'VONO', company: 'Vono Products Plc', sector: 'Consumer Goods' },

	// ── Industrial Goods ──
	{ ticker: 'ALEX', company: 'Aluminium Extrusion Industries Plc', sector: 'Industrial Goods' },
	{ ticker: 'ALUMACO', company: 'Aluminum Manufacturing Company of Nigeria Plc', sector: 'Industrial Goods' },
	{ ticker: 'AUSTINLAZ', company: 'Austin Laz & Company Plc', sector: 'Industrial Goods' },
	{ ticker: 'BERGER', company: 'Berger Paints Nigeria Plc', sector: 'Industrial Goods' },
	{ ticker: 'BETAGLAS', company: 'Beta Glass Plc', sector: 'Industrial Goods' },
	{ ticker: 'BUACEMENT', company: 'BUA Cement Plc', sector: 'Industrial Goods' },
	{ ticker: 'CAP', company: 'Chemical and Allied Products Plc', sector: 'Industrial Goods' },
	{ ticker: 'CUTIX', company: 'Cutix Plc', sector: 'Industrial Goods' },
	{ ticker: 'DANGCEM', company: 'Dangote Cement Plc', sector: 'Industrial Goods' },
	{ ticker: 'NOTORE', company: 'Notore Chemical Industries Plc', sector: 'Industrial Goods' },
	{ ticker: 'PORTPAINT', company: 'Portland Paints & Products Nigeria Plc', sector: 'Industrial Goods' },
	{ ticker: 'PREMPAINTS', company: 'Premium Paints Plc', sector: 'Industrial Goods' },
	{ ticker: 'TRIPPLEG', company: 'Tripple Gee & Company Plc', sector: 'Industrial Goods' },
	{ ticker: 'WAPCO', company: 'Lafarge Africa Plc', sector: 'Industrial Goods' },

	// ── Oil and Gas ──
	{ ticker: 'ARADEL', company: 'Aradel Holdings Plc', sector: 'Oil and Gas' },
	{ ticker: 'CONOIL', company: 'Conoil Plc', sector: 'Oil and Gas' },
	{ ticker: 'ETERNA', company: 'Eterna Plc', sector: 'Oil and Gas' },
	{ ticker: 'JAPAULGOLD', company: 'Japaul Gold & Ventures Plc', sector: 'Oil and Gas' },
	{ ticker: 'MRS', company: 'MRS Oil Nigeria Plc', sector: 'Oil and Gas' },
	{ ticker: 'OANDO', company: 'Oando Plc', sector: 'Oil and Gas' },
	{ ticker: 'SEPLAT', company: 'Seplat Energy Plc', sector: 'Oil and Gas' },
	{ ticker: 'TOTAL', company: 'TotalEnergies Marketing Nigeria Plc', sector: 'Oil and Gas' },
	{ ticker: 'UNIONVENT', company: 'Union Ventures & Petroleum Plc', sector: 'Oil and Gas' },

	// ── Utilities ──
	{ ticker: 'GEREGU', company: 'Geregu Power Plc', sector: 'Utilities' },
	{ ticker: 'TRANSPOWER', company: 'Transcorp Power Plc', sector: 'Utilities' },

	// ── ICT ──
	{ ticker: 'AIRTELAFRI', company: 'Airtel Africa Plc', sector: 'ICT' },
	{ ticker: 'BAPLC', company: 'Briclinks Africa Plc', sector: 'ICT' },
	{ ticker: 'CHAMS', company: 'Chams Holding Company Plc', sector: 'ICT' },
	{ ticker: 'COURTVILLE', company: 'Courteville Business Solutions Plc', sector: 'ICT' },
	{ ticker: 'CWG', company: 'CWG Plc', sector: 'ICT' },
	{ ticker: 'ETRANZACT', company: 'eTranzact International Plc', sector: 'ICT' },
	{ ticker: 'MTNN', company: 'MTN Nigeria Communications Plc', sector: 'ICT' },
	{ ticker: 'NCR', company: 'NCR Nigeria Plc', sector: 'ICT' },
	{ ticker: 'OMATEK', company: 'Omatek Ventures Plc', sector: 'ICT' },

	// ── Conglomerates ──
	{ ticker: 'AGLEVENT', company: 'A.G. Leventis Nigeria Plc', sector: 'Conglomerates' },
	{ ticker: 'CHELLARAM', company: 'Chellarams Plc', sector: 'Conglomerates' },
	{ ticker: 'JOHNHOLT', company: 'John Holt Plc', sector: 'Conglomerates' },
	{ ticker: 'PZ', company: 'PZ Cussons Nigeria Plc', sector: 'Conglomerates' },
	{ ticker: 'SCOA', company: 'SCOA Nigeria Plc', sector: 'Conglomerates' },
	{ ticker: 'TRANSCORP', company: 'Transnational Corporation Plc', sector: 'Conglomerates' },
	{ ticker: 'UACN', company: 'UAC of Nigeria Plc', sector: 'Conglomerates' },

	// ── Agriculture ──
	{ ticker: 'ELLAHLAKES', company: 'Ellah Lakes Plc', sector: 'Agriculture' },
	{ ticker: 'FTNCOCOA', company: 'FTN Cocoa Processors Plc', sector: 'Agriculture' },
	{ ticker: 'LIVESTOCK', company: 'Livestock Feeds Plc', sector: 'Agriculture' },
	{ ticker: 'OKOMUOIL', company: 'Okomu Oil Palm Plc', sector: 'Agriculture' },
	{ ticker: 'PRESCO', company: 'Presco Plc', sector: 'Agriculture' },

	// ── Healthcare ──
	{ ticker: 'AFRIK', company: 'Afrik Pharmaceuticals Plc', sector: 'Healthcare' },
	{ ticker: 'EKOCORP', company: 'Ekocorp Plc', sector: 'Healthcare' },
	{ ticker: 'FIDSON', company: 'Fidson Healthcare Plc', sector: 'Healthcare' },
	{ ticker: 'GLAXOSMITH', company: 'GlaxoSmithKline Consumer Nigeria Plc', sector: 'Healthcare' },
	{ ticker: 'MAYBAKER', company: 'May & Baker Nigeria Plc', sector: 'Healthcare' },
	{ ticker: 'MORISON', company: 'Morison Industries Plc', sector: 'Healthcare' },
	{ ticker: 'NEIMETH', company: 'Neimeth International Pharmaceuticals Plc', sector: 'Healthcare' },
	{ ticker: 'PHARMADEKO', company: 'Pharma-Deko Plc', sector: 'Healthcare' },
	{ ticker: 'UNIONDAC', company: 'Union Diagnostic & Clinical Services Plc', sector: 'Healthcare' },

	// ── Services ──
	{ ticker: 'ABCTRANS', company: 'Associated Bus Company Plc', sector: 'Services' },
	{ ticker: 'ACADEMY', company: 'Academy Press Plc', sector: 'Services' },
	{ ticker: 'AEROCONTRACT', company: 'Aero Contractors', sector: 'Services' },
	{ ticker: 'AFROMEDIA', company: 'Afromedia Plc', sector: 'Services' },
	{ ticker: 'AIRSERVICE', company: 'Airline Services & Logistics Plc', sector: 'Services' },
	{ ticker: 'CAVERTON', company: 'Caverton Offshore Support Group Plc', sector: 'Services' },
	{ ticker: 'CILEASING', company: 'C & I Leasing Plc', sector: 'Services' },
	{ ticker: 'IKEJAHOTEL', company: 'Ikeja Hotel Plc', sector: 'Services' },
	{ ticker: 'JULI', company: 'Juli Plc', sector: 'Services' },
	{ ticker: 'LEARNAFRCA', company: 'Learn Africa Plc', sector: 'Services' },
	{ ticker: 'MEDVIEWAIR', company: 'Med-View Airline Plc', sector: 'Services' },
	{ ticker: 'NAHCO', company: 'Nigerian Aviation Handling Company Plc', sector: 'Services' },
	{ ticker: 'REDSTAREX', company: 'Red Star Express Plc', sector: 'Services' },
	{ ticker: 'RTBRISCOE', company: 'R.T. Briscoe Nigeria Plc', sector: 'Services' },
	{ ticker: 'SKYAVN', company: 'Skyway Aviation Handling Company Plc', sector: 'Services' },
	{ ticker: 'SMURFIT', company: 'Smart Products Nigeria Plc', sector: 'Services' },
	{ ticker: 'STUDPRESS', company: 'Studio Press Nigeria Plc', sector: 'Services' },
	{ ticker: 'TANTALIZER', company: 'Tantalizers Plc', sector: 'Services' },
	{ ticker: 'TIP', company: 'The Initiative Plc', sector: 'Services' },
	{ ticker: 'TRANSEXPR', company: 'Trans-Nationwide Express Plc', sector: 'Services' },
	{ ticker: 'UPL', company: 'University Press Plc', sector: 'Services' },

	// ── Construction/Real Estate ──
	{ ticker: 'AVAIF', company: 'AVA Infrastructure Fund', sector: 'Construction/Real Estate' },
	{ ticker: 'CAPHOTEL', company: 'Capital Hotels Plc', sector: 'Construction/Real Estate' },
	{ ticker: 'JBERGER', company: 'Julius Berger Nigeria Plc', sector: 'Construction/Real Estate' },
	{ ticker: 'PROSREALT', company: 'Pro Realtors Plc', sector: 'Construction/Real Estate' },
	{ ticker: 'TOURIST', company: 'Tourist Company of Nigeria Plc', sector: 'Construction/Real Estate' },
	{ ticker: 'TRANSCOHOT', company: 'Transcorp Hotels Plc', sector: 'Construction/Real Estate' },
	{ ticker: 'UAC-PROP', company: 'UACN Property Development Company', sector: 'Construction/Real Estate' },
	{ ticker: 'UPDC', company: 'UPDC Real Estate Investment Trust', sector: 'Construction/Real Estate' },

	// ── Natural Resources ──
	{ ticker: 'BOCGAS', company: 'BOC Gases Nigeria Plc', sector: 'Natural Resources' },
	{ ticker: 'MULTIVERSE', company: 'Multiverse Mining & Exploration Plc', sector: 'Natural Resources' },
];
