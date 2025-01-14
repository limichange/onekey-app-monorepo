import BigNumber from 'bignumber.js';
import { uniqBy } from 'lodash';

import { SEARCH_KEY_MIN_LENGTH } from '../consts/walletConsts';

import type { IAccountToken, ITokenData, ITokenFiat } from '../../types/token';

export function getMergedTokenData({
  tokens,
  smallBalanceTokens,
  riskTokens,
}: {
  tokens: ITokenData;
  smallBalanceTokens: ITokenData;
  riskTokens: ITokenData;
}) {
  const mergedTokens = [
    ...tokens.data,
    ...smallBalanceTokens.data,
    ...riskTokens.data,
  ];

  const mergedKeys = `${tokens.keys}_${smallBalanceTokens.keys}_${riskTokens.keys}`;

  const mergedTokenMap = {
    ...tokens.map,
    ...smallBalanceTokens.map,
    ...riskTokens.map,
  };

  return {
    allTokens: {
      data: mergedTokens,
      keys: mergedKeys,
      map: mergedTokenMap,
    },
    tokens,
    riskTokens,
    smallBalanceTokens,
  };
}

export function getEmptyTokenData() {
  return {
    allTokens: {
      data: [],
      keys: '',
      map: {},
    },
    tokens: {
      data: [],
      keys: '',
      map: {},
    },
    riskTokens: {
      data: [],
      keys: '',
      map: {},
    },
    smallBalanceTokens: {
      data: [],
      keys: '',
      map: {},
    },
  };
}

export function getFilteredTokenBySearchKey({
  tokens,
  searchKey,
  searchAll,
  searchTokenList,
}: {
  tokens: IAccountToken[];
  searchKey: string;
  searchAll?: boolean;
  searchTokenList?: IAccountToken[];
}) {
  let mergedTokens = tokens;

  if (searchAll && searchTokenList) {
    mergedTokens = mergedTokens.concat(searchTokenList);
    mergedTokens = uniqBy(
      mergedTokens,
      (token) => `${token.address}_${token.networkId ?? ''}`,
    );
  }
  if (!searchKey || searchKey.length < SEARCH_KEY_MIN_LENGTH) {
    return mergedTokens;
  }

  // eslint-disable-next-line no-param-reassign
  searchKey = searchKey.trim().toLowerCase();

  const filteredTokens = mergedTokens.filter(
    (token) =>
      token.name?.toLowerCase().includes(searchKey) ||
      token.symbol?.toLowerCase().includes(searchKey) ||
      token.address?.toLowerCase() === searchKey,
  );

  return filteredTokens;
}

export function sortTokensByFiatValue({
  tokens,
  map = {},
}: {
  tokens: IAccountToken[];
  map?: {
    [key: string]: ITokenFiat;
  };
}) {
  return tokens.sort((a, b) => {
    const aFiat = map[a.$key]?.fiatValue ?? 0;
    const bFiat = map[b.$key]?.fiatValue ?? 0;

    return new BigNumber(bFiat).comparedTo(aFiat);
  });
}
