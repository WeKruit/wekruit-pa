"""Read supplied recruiting files into local demo fixtures; never modify sources."""
import csv
import json
import random
import re
from pathlib import Path
from urllib.parse import urlparse
from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[2]
FILES = [Path('/Users/noahliu/Downloads/outputs-catchem-founding-ceo-candidates.csv'), Path('/Users/noahliu/Downloads/outputs-catchem-founding-ceo-candidates (1).csv'), Path('/Users/noahliu/Documents/New project/outputs/catchem_founder_20260914/catchem_founder_candidates.xlsx')]
records = []
counts = {}
columns = []
for path in FILES[:2]:
    with path.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        if not columns:
            columns = reader.fieldnames
        rows = list(reader)
    counts[path.name] = len(rows)
    for index, original in enumerate(rows, 2):
        row = {key: original.get(key, '') for key in columns}
        row['graduation_year'] = original.get('graduation_year', original.get('grad_year', ''))
        records.append({'row': row, 'sources': [{'file': path.name, 'row': index, 'fields': original}]})

def link(value):
    value = str(value or '')
    found = re.search(r'linkLocation=(https?://.*?), friendlyName=', value)
    return found.group(1) if found else value

workbook = load_workbook(FILES[2], read_only=True, data_only=True)
sheet = list(workbook['Candidates'].values)
headers = sheet[3]
count = 0
for index, cells in enumerate(sheet[4:], 5):
    if len(cells) < 2 or not cells[1]:
        continue
    original = {str(key): str(value if value is not None else '') for key, value in zip(headers, cells)}
    row = {key: '' for key in columns}
    mapping = {'name': 'Name', 'current_role': 'Current role', 'location': 'US location', 'school': 'School / graduation', 'venture_evidence': 'Project / traction evidence', 'card_evidence': 'Card-interest evidence', 'technical_evidence': 'Technical evidence', 'outreach_hook': 'Personalized outreach hook', 'fit_score': 'Fit / 10', 'fit_rationale': 'Next verification', 'linkedin_url': 'LinkedIn', 'github_url': 'GitHub', 'twitter_handle': 'X'}
    for key, source in mapping.items():
        row[key] = link(original.get(source, ''))
    row['other_links'] = ', '.join(dict.fromkeys(link(original.get(k, '')) for k in ['Project source', 'Card proof', 'Other source'] if original.get(k)))
    row['source_url'] = row['other_links']
    row['rule_technical_background'] = 'match' if row['technical_evidence'] else 'unclear'
    row['rule_prior_venture'] = 'match' if re.search(r'\b(?:co-founder|founder)\b', row['current_role'], re.I) else 'unclear'
    row['rule_card_enthusiast'] = 'unclear'
    # Preserve uncertainty: source location, not citizenship or work authorization.
    row['rule_us_based'] = 'unclear' if re.search(r'unknown|unconfirmed|verify|unclear|not confirmed', row['location'], re.I) or not row['location'] else 'match'
    records.append({'row': row, 'sources': [{'file': FILES[2].name, 'sheet': 'Candidates', 'row': index, 'fields': original}]})
    count += 1
counts[FILES[2].name] = count

def keys(row):
    result = []
    for field in ['linkedin_url', 'github_url']:
        value = row[field].strip()
        parsed = urlparse(value)
        host = parsed.netloc.lower().removeprefix('www.')
        path = parsed.path.rstrip('/').lower()
        if host == 'linkedin.com' and path.startswith('/in/'):
            result.append(host + path)
        if host == 'github.com' and len(path.strip('/').split('/')) == 1 and path:
            result.append(host + path)
    return result

merged = []
duplicates = []
for record in records:
    identities = set(keys(record['row']))
    match = next((r for r in merged if identities & set(keys(r['row']))), None)
    if match is None:
        merged.append(record)
    else:
        duplicates.append([record['row']['name'], match['row']['name']])
        match['sources'].extend(record['sources'])
        for key, value in record['row'].items():
            if not match['row'][key]:
                match['row'][key] = value
            elif value and key in ['technical_evidence', 'venture_evidence', 'card_evidence', 'current_role', 'source_url', 'other_links'] and value not in match['row'][key]:
                match['row'][key] += '\n' + value
            elif key.startswith('rule_') and value == 'match':
                match['row'][key] = value

lei = next(i for i, r in enumerate(merged) if r['row']['name'].lower() == 'lei liu')
chosen = random.Random(20260930).sample([i for i in range(len(merged)) if i != lei], 4) + [lei]
out = '// Imported recruiting evidence. Source fields are retained; demo network labels are synthetic.\n'
out += 'export const CSV_COLUMNS = ' + json.dumps(columns) + ' as const\nexport type CsvColumn = typeof CSV_COLUMNS[number]\nexport type SourceRow = Record<CsvColumn, string>\n'
out += 'export const CSV_ROWS: SourceRow[] = ' + json.dumps([r['row'] for r in merged], ensure_ascii=False, indent=2) + '\n'
out += 'export const SOURCE_RECORDS: { file: string; row: number; sheet?: string; fields: Record<string, string> }[][] = ' + json.dumps([r['sources'] for r in merged], ensure_ascii=False, indent=2) + '\n'
out += 'export const IMPORT_COUNTS = ' + json.dumps(counts) + '\n'
out += 'export const DEMO_NETWORK_ROWS = ' + json.dumps(chosen) + '\n'
(ROOT / 'apps/dashboard-web/src/pages/catchem-candidates.ts').write_text(out)
print(json.dumps({'input_rows': sum(counts.values()), 'unique': len(merged), 'merged': duplicates, 'network': [merged[i]['row']['name'] for i in chosen], 'lei_profile': merged[lei]['row']}, indent=2))
