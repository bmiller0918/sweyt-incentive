export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 50) * 1024 * 1024,
  fiscalYearStartMonth: Number(process.env.FISCAL_YEAR_START_MONTH ?? 1),
  weekStartsOn: (Number(process.env.WEEK_STARTS_ON ?? 1) === 0 ? 0 : 1) as 0 | 1,
  isProduction: process.env.NODE_ENV === 'production',
};
