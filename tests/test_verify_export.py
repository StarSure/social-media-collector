import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

source = Path(__file__).resolve().parents[1] / 'scripts/verify_export.py'
spec = importlib.util.spec_from_file_location('verify_export', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExportVerificationTests(unittest.TestCase):
    def test_sparse_xlsx_preserves_id_and_column_alignment(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'actual.xlsx'
            with zipfile.ZipFile(file, 'w') as z:
                z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="r1"/></sheets></workbook>')
                z.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="r1" Target="worksheets/export.xml"/></Relationships>')
                z.writestr('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>笔记ID</t></si><si><t>可空</t></si><si><t>笔记标题</t></si><si><t>9007199254740993</t></si><si><r><t>真实</t></r><r><t>标题</t></r></si></sst>')
                z.writestr('xl/worksheets/export.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="C2" t="s"><v>4</v></c></row></sheetData></worksheet>')
            columns, rows = module.read_export(file)
            self.assertEqual(columns, ['笔记ID', '可空', '笔记标题'])
            self.assertEqual(rows, [{'笔记ID': '9007199254740993', '可空': '', '笔记标题': '真实标题'}])
            self.assertEqual(module.verify(file, 1, '笔记ID', ['笔记标题'])['status'], 'passed')

    def test_shortfall_duplicate_and_missing_values_are_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'actual.csv'
            file.write_text('\ufeff笔记ID,笔记标题\nx,标题\nx,\n', encoding='utf-8')
            result = module.verify(file, 3, '笔记ID', ['笔记标题'])
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['recordCount'], 2)
            self.assertEqual(result['uniqueIds'], 1)
            self.assertEqual(len(result['errors']), 3)

    def test_duplicate_csv_headers_are_not_silently_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'actual.csv'
            file.write_text('ID,ID\nx,y\n', encoding='utf-8')
            self.assertEqual(module.verify(file)['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
