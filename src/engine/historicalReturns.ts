/**
 * What U.S. markets actually did, year by year, for the stress tests that
 * replay a real decade ("if your retirement year looked like 1966") and for
 * a Monte Carlo that draws from history rather than from a bell curve.
 *
 * Sources, rounded to a tenth of a percent: S&P 500 total return (price plus
 * dividends) and 10-year Treasury total return from Aswath Damodaran's
 * annual "Historical Returns on Stocks, Bonds and Bills" table (NYU Stern);
 * inflation is the BLS CPI-U annual average. Update by appending a year.
 */
export interface MarketYear {
  year: number;
  /** S&P 500 total return, nominal. */
  stocks: number;
  /** 10-year Treasury total return, nominal. */
  bonds: number;
  /** CPI-U, annual average over the prior year. */
  inflation: number;
}

const ROWS: [number, number, number, number][] = [
  [1928, 43.8, 0.8, -1.7],
  [1929, -8.3, 4.2, 0.0],
  [1930, -25.1, 4.5, -2.3],
  [1931, -43.8, -2.6, -9.0],
  [1932, -8.6, 8.8, -9.9],
  [1933, 50.0, 1.9, -5.1],
  [1934, -1.2, 8.0, 3.1],
  [1935, 46.7, 4.5, 2.2],
  [1936, 31.9, 5.0, 1.5],
  [1937, -35.3, 1.4, 3.6],
  [1938, 29.3, 4.2, -2.1],
  [1939, -1.1, 4.4, -1.4],
  [1940, -10.7, 5.4, 0.7],
  [1941, -12.8, -2.0, 5.0],
  [1942, 19.2, 2.3, 10.9],
  [1943, 25.1, 2.5, 6.1],
  [1944, 19.0, 2.6, 1.7],
  [1945, 35.8, 3.8, 2.3],
  [1946, -8.4, 3.1, 8.3],
  [1947, 5.2, 0.9, 14.4],
  [1948, 5.7, 2.0, 8.1],
  [1949, 18.3, 4.7, -1.2],
  [1950, 30.8, 0.4, 1.3],
  [1951, 23.7, -0.3, 7.9],
  [1952, 18.2, 2.3, 1.9],
  [1953, -1.2, 4.1, 0.8],
  [1954, 52.6, 3.3, 0.7],
  [1955, 32.6, -1.3, -0.4],
  [1956, 7.4, -2.3, 1.5],
  [1957, -10.5, 6.8, 3.3],
  [1958, 43.7, -2.1, 2.8],
  [1959, 12.1, -2.7, 0.7],
  [1960, 0.3, 11.6, 1.7],
  [1961, 26.6, 2.1, 1.0],
  [1962, -8.8, 5.7, 1.0],
  [1963, 22.6, 1.7, 1.3],
  [1964, 16.4, 3.7, 1.3],
  [1965, 12.4, 0.7, 1.6],
  [1966, -10.0, 2.9, 2.9],
  [1967, 23.8, -1.6, 3.1],
  [1968, 10.8, 3.3, 4.2],
  [1969, -8.2, -5.0, 5.5],
  [1970, 3.6, 16.8, 5.7],
  [1971, 14.2, 9.8, 4.4],
  [1972, 18.8, 2.8, 3.2],
  [1973, -14.3, 3.7, 6.2],
  [1974, -25.9, 2.0, 11.0],
  [1975, 37.0, 3.6, 9.1],
  [1976, 23.8, 16.0, 5.8],
  [1977, -7.0, 1.3, 6.5],
  [1978, 6.5, -0.8, 7.6],
  [1979, 18.5, 0.7, 11.3],
  [1980, 31.7, -3.0, 13.5],
  [1981, -4.7, 8.2, 10.3],
  [1982, 20.4, 32.8, 6.2],
  [1983, 22.3, 3.2, 3.2],
  [1984, 6.2, 13.7, 4.3],
  [1985, 31.2, 25.7, 3.6],
  [1986, 18.5, 24.3, 1.9],
  [1987, 5.8, -5.0, 3.6],
  [1988, 16.5, 8.2, 4.1],
  [1989, 31.5, 17.7, 4.8],
  [1990, -3.1, 6.2, 5.4],
  [1991, 30.2, 15.0, 4.2],
  [1992, 7.5, 9.4, 3.0],
  [1993, 10.0, 14.2, 3.0],
  [1994, 1.3, -8.0, 2.6],
  [1995, 37.2, 23.5, 2.8],
  [1996, 22.7, 1.4, 3.0],
  [1997, 33.1, 9.9, 2.3],
  [1998, 28.3, 14.9, 1.6],
  [1999, 20.9, -8.3, 2.2],
  [2000, -9.0, 16.7, 3.4],
  [2001, -11.9, 5.6, 2.8],
  [2002, -22.0, 15.1, 1.6],
  [2003, 28.4, 0.4, 2.3],
  [2004, 10.7, 4.5, 2.7],
  [2005, 4.8, 2.9, 3.4],
  [2006, 15.6, 2.0, 3.2],
  [2007, 5.5, 10.2, 2.8],
  [2008, -36.6, 20.1, 3.8],
  [2009, 25.9, -11.1, -0.4],
  [2010, 14.8, 8.5, 1.6],
  [2011, 2.1, 16.0, 3.2],
  [2012, 15.9, 3.0, 2.1],
  [2013, 32.2, -9.1, 1.5],
  [2014, 13.5, 10.8, 1.6],
  [2015, 1.4, 1.3, 0.1],
  [2016, 11.8, 0.7, 1.3],
  [2017, 21.6, 2.8, 2.1],
  [2018, -4.2, 0.0, 2.4],
  [2019, 31.2, 9.6, 1.8],
  [2020, 18.0, 11.3, 1.2],
  [2021, 28.5, -4.4, 4.7],
  [2022, -18.0, -17.8, 8.0],
  [2023, 26.1, 3.9, 4.1],
  [2024, 24.9, -1.6, 2.9],
];

export const MARKET_HISTORY: readonly MarketYear[] = ROWS.map(([year, stocks, bonds, inflation]) => ({
  year,
  stocks: stocks / 100,
  bonds: bonds / 100,
  inflation: inflation / 100,
}));

export const MARKET_HISTORY_FIRST_YEAR = MARKET_HISTORY[0].year;
export const MARKET_HISTORY_LAST_YEAR = MARKET_HISTORY[MARKET_HISTORY.length - 1].year;

/**
 * What a portfolio holding `equityShare` in stocks and the rest in bonds
 * earned in one historical year, AFTER that year's inflation. The engine
 * models inflation as one plan-wide rate, so a replay hands it real returns
 * plus the plan's own inflation: the purchasing-power story of the year is
 * preserved without pretending 1974's 11% inflation lasted the whole plan.
 */
export function realBlendedReturn(row: MarketYear, equityShare: number): number {
  const nominal = equityShare * row.stocks + (1 - equityShare) * row.bonds;
  return (1 + nominal) / (1 + row.inflation) - 1;
}

/** The historical rows for `years` consecutive years from `startYear` (fewer when history runs out). */
export function marketWindow(startYear: number, years: number): MarketYear[] {
  const start = startYear - MARKET_HISTORY_FIRST_YEAR;
  if (start < 0 || start >= MARKET_HISTORY.length) return [];
  return MARKET_HISTORY.slice(start, start + years);
}

/**
 * The bad decades a retirement can start in. Each is a hazard of retiring in
 * any era, chosen because it broke a different thing: a crash, a grind, an
 * inflation shock, two crashes in a row, and the one the reader remembers.
 */
export interface HistoricalEra {
  startYear: number;
  label: string;
  /** What made it hard, in one clause. */
  summary: string;
}

export const HISTORICAL_ERAS: readonly HistoricalEra[] = [
  { startYear: 1929, label: "1929: the Great Depression", summary: "stocks lost four-fifths of their value in three years and took a decade and a half to recover" },
  { startYear: 1966, label: "1966: the long stagnation", summary: "sixteen years of flat markets and rising inflation, the worst decade a retiree has faced" },
  { startYear: 1973, label: "1973: the oil shock", summary: "a 40% crash while inflation ran near 10%, so cash lost value as fast as stocks" },
  { startYear: 2000, label: "2000: the lost decade", summary: "the dot-com bust, then the financial crisis before the recovery had finished" },
  { startYear: 2008, label: "2008: the financial crisis", summary: "a 37% loss in one year, followed by a strong recovery" },
];

/** How many years each replay covers: the shock and the recovery that follows it. */
export const HISTORICAL_ERA_YEARS = 15;
