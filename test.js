require('dotenv').config()

console.log('Testando variáveis...')
console.log('SPREADSHEET_ID:', process.env.SPREADSHEET_ID ? 'OK' : 'FALTANDO')
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'OK' : 'FALTANDO')

try {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS)
  console.log('GOOGLE_CREDENTIALS: OK, project_id =', creds.project_id)
} catch(e) {
  console.error('GOOGLE_CREDENTIALS: ERRO -', e.message)
}