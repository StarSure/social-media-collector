#!/usr/bin/env python3
"""Read a real export and check row counts, IDs, and required values without Excel."""
import argparse
import csv
import json
from pathlib import Path
import posixpath
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}


def read_export(path):
    if path.suffix.lower() == '.csv':
        with path.open(encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            return list(reader.fieldnames or []), list(reader)
    if path.suffix.lower() != '.xlsx':
        raise ValueError('仅支持实际下载的 .xlsx 或 .csv 文件')
    with zipfile.ZipFile(path) as archive:
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(t.text or '' for t in item.findall('.//m:t', NS))
                       for item in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('m:si', NS)]
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        sheet = workbook.find('m:sheets/m:sheet', NS)
        if sheet is None:
            raise ValueError('工作簿没有工作表')
        relationship = sheet.get('{' + NS['r'] + '}id')
        rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        rel = next((r for r in rels if r.get('Id') == relationship), None)
        if rel is None or rel.get('TargetMode') == 'External':
            raise ValueError('第一张工作表没有本地数据')
        target = rel.get('Target', '')
        target = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
        root = ET.fromstring(archive.read(target))
        rows = []
        for row in root.findall('m:sheetData/m:row', NS):
            cells = {}
            for cell in row.findall('m:c', NS):
                column = ''.join(c for c in cell.get('r', '') if c.isalpha())
                value_node = cell.find('m:v', NS)
                value = value_node.text or '' if value_node is not None else ''
                if cell.get('t') == 's':
                    value = strings[int(value)]
                elif cell.get('t') == 'inlineStr':
                    value = ''.join(t.text or '' for t in cell.findall('.//m:t', NS))
                cells[column] = value
            if any(v != '' for v in cells.values()):
                rows.append(cells)
        if not rows:
            return [], []
        header = rows[0]
        names = list(header.values())
        if not all(names) or len(set(names)) != len(names):
            raise ValueError('导出表头为空或重复，无法可靠映射字段')
        return names, [{name: row.get(column, '') for column, name in header.items()} for row in rows[1:]]


def verify(path, expected_count=None, id_column=None, required_columns=(), allow_empty=False):
    columns, records = read_export(path)
    errors = []
    if not all(columns) or len(set(columns)) != len(columns):
        errors.append('表头为空或重复，无法可靠映射字段')
    if not records and not allow_empty:
        errors.append('导出没有数据记录')
    if expected_count is not None and len(records) != expected_count:
        errors.append(f'期望{expected_count}条，实际{len(records)}条')
    for column in required_columns:
        if column not in columns:
            errors.append(f'缺少字段：{column}')
        elif any(record.get(column, '') == '' for record in records):
            errors.append(f'字段存在空值：{column}')
    unique_count = None
    if id_column:
        if id_column not in columns:
            errors.append(f'缺少ID字段：{id_column}')
        else:
            ids = [r.get(id_column, '') for r in records]
            unique_count = len(set(ids))
            if any(value == '' for value in ids):
                errors.append('存在空ID')
            if unique_count != len(ids):
                errors.append(f'存在重复ID：{len(ids) - unique_count}条')
    return {'status': 'passed' if not errors else 'failed', 'file': str(path.resolve()),
            'bytes': path.stat().st_size, 'recordCount': len(records), 'columnCount': len(columns),
            'columns': columns, 'idColumn': id_column, 'uniqueIds': unique_count,
            'expectedCount': expected_count, 'errors': errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--expected-count', type=int)
    parser.add_argument('--id-column')
    parser.add_argument('--required-column', action='append', default=[])
    parser.add_argument('--allow-empty', action='store_true')
    parser.add_argument('--output', type=Path, help='保存核验摘要，不包含逐条评论或账号资料')
    args = parser.parse_args()
    if args.expected_count is not None and args.expected_count < 0:
        parser.error('--expected-count 不能为负数')
    try:
        result = verify(args.file, args.expected_count, args.id_column, args.required_column, args.allow_empty)
    except (OSError, ValueError, KeyError, IndexError, zipfile.BadZipFile, ET.ParseError) as error:
        result = {'status': 'failed', 'file': str(args.file), 'errors': [str(error)]}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['status'] == 'passed' else 2


if __name__ == '__main__':
    sys.exit(main())
