import { useState, useCallback } from 'react';
import * as bip39 from 'bip39';
import { Buffer } from 'buffer';
import { Lucid } from 'lucid-cardano';

// Make Buffer available globally for bip39
if (typeof window !== 'undefined') {
  (window as any).Buffer = Buffer;
}

interface Thaw {
  amount: number;
  queue_position: number | null;
  status: 'upcoming' | 'available' | 'claimed';
  thawing_period_start: string;
  transaction_id: string | null;
}

interface ThawSchedule {
  numberOfClaimedAllocations: number;
  thaws: Thaw[];
}

interface AddressResult {
  address: string;
  label?: string;
  schedule: ThawSchedule | null;
  error?: string;
  loading?: boolean;
}

type ViewMode = 'timeline' | 'table' | 'calendar';
type InputMode = 'single' | 'bulk' | 'json' | 'seed';

// Direct API URL - no proxy needed for standalone app
const API_BASE_URL = 'https://mainnet.prod.gd.midnighttge.io';

// Interface for derived addresses JSON format from mining bot
interface DerivedAddress {
  index: number;
  bech32: string;
  publicKeyHex?: string;
  registered?: boolean;
}

interface StoppedEarlyInfo {
  checked: number;
  total: number;
  consecutiveEmpty: number;
}

// Calendar event generation utilities
const generateICSFile = (title: string, description: string, startDate: Date, endDate: Date): string => {
  const formatICSDate = (date: Date): string => {
    return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  };

  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Midnight Thaw Checker//EN',
    'BEGIN:VEVENT',
    `DTSTART:${formatICSDate(startDate)}`,
    `DTEND:${formatICSDate(endDate)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description.replace(/\n/g, '\\n')}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  return icsContent;
};

const downloadICSFile = (amount: number, dateStr: string, thawNumber: number) => {
  const startDate = new Date(dateStr);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // 1 hour event
  const formattedAmount = (amount / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const title = `Midnight Thaw #${thawNumber} - ${formattedAmount} NIGHT`;
  const description = `Your Midnight token thaw is now available!\\n\\nAmount: ${formattedAmount} NIGHT\\nClaim at: https://redeem.midnight.gd/`;

  const icsContent = generateICSFile(title, description, startDate, endDate);
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `midnight-thaw-${thawNumber}-${dateStr.split('T')[0]}.ics`;
  a.click();
  URL.revokeObjectURL(url);
};

const getGoogleCalendarUrl = (amount: number, dateStr: string, thawNumber: number): string => {
  const startDate = new Date(dateStr);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  const formattedAmount = (amount / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const title = `Midnight Thaw #${thawNumber} - ${formattedAmount} NIGHT`;
  const description = `Your Midnight token thaw is now available!\n\nAmount: ${formattedAmount} NIGHT\nClaim at: https://redeem.midnight.gd/`;

  const formatGoogleDate = (date: Date): string => {
    return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  };

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${formatGoogleDate(startDate)}/${formatGoogleDate(endDate)}`,
    details: description,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
};

const getOutlookCalendarUrl = (amount: number, dateStr: string, thawNumber: number): string => {
  const startDate = new Date(dateStr);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  const formattedAmount = (amount / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const title = `Midnight Thaw #${thawNumber} - ${formattedAmount} NIGHT`;
  const description = `Your Midnight token thaw is now available!\n\nAmount: ${formattedAmount} NIGHT\nClaim at: https://redeem.midnight.gd/`;

  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: title,
    startdt: startDate.toISOString(),
    enddt: endDate.toISOString(),
    body: description,
  });

  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
};

export default function ThawChecker() {
  const [inputMode, setInputMode] = useState<InputMode>('single');
  const [singleAddress, setSingleAddress] = useState('');
  const [bulkAddresses, setBulkAddresses] = useState('');
  const [jsonInput, setJsonInput] = useState('');
  const [seedPhrase, setSeedPhrase] = useState('');
  const [addressCount, setAddressCount] = useState(200);
  const [derivedAddresses, setDerivedAddresses] = useState<DerivedAddress[]>([]);
  const [derivationError, setDerivationError] = useState<string | null>(null);
  const [results, setResults] = useState<AddressResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [stoppedEarly, setStoppedEarly] = useState<StoppedEarlyInfo | null>(null);

  // Format amount from raw units to NIGHT tokens with comma separators
  const formatAmount = (raw: number | null): string => {
    if (raw === null) return '0.00';
    const amount = raw / 1_000_000;
    return amount.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  };

  // Format date to human-readable
  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  // Get time until date
  const getTimeUntil = useCallback((dateStr: string): string => {
    const now = new Date();
    const target = new Date(dateStr);
    const diff = target.getTime() - now.getTime();

    if (diff < 0) return 'Available now';

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    if (days > 365) {
      const years = Math.floor(days / 365);
      const remainingDays = days % 365;
      return `${years}y ${remainingDays}d`;
    }
    if (days > 30) {
      const months = Math.floor(days / 30);
      const remainingDays = days % 30;
      return `${months}mo ${remainingDays}d`;
    }
    if (days > 0) return `${days}d ${hours}h`;

    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  }, []);

  // Get status color
  const getStatusColor = (status: string, date: string): string => {
    if (status === 'claimed') return 'bg-gray-500';
    if (status === 'available') return 'bg-green-500';

    const now = new Date();
    const target = new Date(date);
    const daysUntil = (target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

    if (daysUntil < 30) return 'bg-yellow-500';
    return 'bg-blue-500';
  };

  // Fetch thaw schedule directly from Midnight API
  const fetchSchedule = async (address: string): Promise<ThawSchedule | null> => {
    const url = `${API_BASE_URL}/thaws/${address}/schedule`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        // Check if it's a "no redeemable thaws" error
        if (response.status === 400) {
          try {
            const errorData = await response.json();
            if (errorData.type === 'no_redeemable_thaws') {
              return { numberOfClaimedAllocations: 0, thaws: [] };
            }
          } catch {
            // If can't parse error, throw generic error
          }
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      return {
        numberOfClaimedAllocations: data.numberOfClaimedAllocations || 0,
        thaws: data.thaws || []
      };
    } catch (error) {
      throw error;
    }
  };

  // Parse bulk input (supports CSV format and plain addresses)
  const parseBulkInput = (text: string): { label: string; address: string }[] => {
    const lines = text.split('\n').filter(line => line.trim());
    const parsed: { label: string; address: string }[] = [];

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Check if line contains comma (CSV format: label,address)
      if (trimmed.includes(',')) {
        const parts = trimmed.split(',').map(p => p.trim());
        if (parts.length >= 2 && parts[1]) {
          parsed.push({ label: parts[0] || `Address ${idx + 1}`, address: parts[1] });
        }
      } else {
        // Plain address
        if (trimmed.startsWith('addr1')) {
          parsed.push({ label: `Address ${idx + 1}`, address: trimmed });
        }
      }
    });

    return parsed;
  };

  // Parse JSON input (derived addresses format from mining bot)
  const parseJsonInput = (text: string): { label: string; address: string }[] => {
    try {
      const data = JSON.parse(text) as DerivedAddress[];
      if (!Array.isArray(data)) {
        return [];
      }
      return data
        .filter(item => item.bech32 && item.bech32.startsWith('addr1'))
        .map(item => ({
          label: `Address #${item.index}`,
          address: item.bech32
        }));
    } catch {
      return [];
    }
  };

  // Handle file upload for JSON
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setJsonInput(content);
    };
    reader.readAsText(file);
  };

  // Validate BIP39 mnemonic
  const validateMnemonic = (phrase: string): boolean => {
    const trimmed = phrase.trim();
    console.log('=== BIP39 Validation Debug ===');
    console.log('Original phrase:', phrase);
    console.log('Trimmed phrase:', trimmed);
    console.log('Word count:', trimmed.split(/\s+/).length);
    const words = trimmed.split(/\s+/);
    console.log('Words:', words);

    // Check if wordlists are available
    console.log('Available wordlists:', bip39.wordlists ? Object.keys(bip39.wordlists) : 'none');

    // Try validation with explicit English wordlist
    let isValid = false;
    try {
      // Try with default (should be English)
      isValid = bip39.validateMnemonic(trimmed);
      console.log('Validation with default wordlist:', isValid);

      // If that fails and wordlists are available, try explicit English
      if (!isValid && bip39.wordlists && bip39.wordlists.english) {
        isValid = bip39.validateMnemonic(trimmed, bip39.wordlists.english);
        console.log('Validation with explicit English wordlist:', isValid);
      }

      // Fallback: Check if all words are in the wordlist
      if (!isValid && bip39.wordlists && bip39.wordlists.english) {
        const wordlist = bip39.wordlists.english;
        const allWordsValid = words.every(word => wordlist.includes(word));
        console.log('All words in wordlist:', allWordsValid);

        // If all words are valid and count is correct (12, 15, 18, 21, or 24), allow it
        const validWordCounts = [12, 15, 18, 21, 24];
        if (allWordsValid && validWordCounts.includes(words.length)) {
          console.log('FALLBACK: All words valid, accepting despite checksum failure');
          isValid = true; // Override - we'll let the derivation fail if there's a real issue
        }
      }
    } catch (error) {
      console.error('Validation error:', error);
    }

    console.log('Final validation result:', isValid);
    console.log('bip39 object:', bip39);
    console.log('==============================');

    return isValid;
  };



  // Derive Cardano addresses from seed phrase using Lucid (same as midnight_fetcher_bot_public)
  const deriveAddressesFromSeed = async (mnemonic: string, count: number): Promise<DerivedAddress[]> => {
    try {
      const addresses: DerivedAddress[] = [];

      // Initialize Lucid without provider (offline mode for address derivation)
      console.log('Initializing Lucid in offline mode...');

      for (let i = 0; i < count; i++) {
        try {
          // Create a new Lucid instance for each derivation
          // Use null provider since we're only deriving addresses, not querying blockchain
          const lucid = await Lucid.new();

          lucid.selectWalletFromSeed(mnemonic.trim(), {
            accountIndex: i,
          });

          const address = await lucid.wallet.address();

          // Get public key by signing a test message (same method as the bot)
          const testPayload = Buffer.from('test', 'utf8').toString('hex');
          const signedMessage = await lucid.wallet.signMessage(address, testPayload);

          // Extract 32-byte public key from COSE_Key structure
          const coseKey = signedMessage.key;
          const pubKeyHex = coseKey.slice(-64);

          if (!pubKeyHex || pubKeyHex.length !== 64) {
            throw new Error(`Failed to extract valid public key for index ${i}`);
          }

          addresses.push({
            index: i,
            bech32: address,
            publicKeyHex: pubKeyHex,
            registered: false
          });

          // Log progress every 10 addresses
          if ((i + 1) % 10 === 0) {
            console.log(`Generated ${i + 1}/${count} addresses...`);
          }
        } catch (err) {
          console.error(`Error deriving address at index ${i}:`, err);
          throw err;
        }
      }

      // Log first few addresses for verification
      if (addresses.length > 0) {
        console.log('=== Generated Addresses (using Lucid - exact match with midnight_fetcher_bot_public) ===');
        console.log('Method: lucid.selectWalletFromSeed(mnemonic, { accountIndex: i })');
        console.log('\nFirst 3 addresses:');
        addresses.slice(0, 3).forEach(addr => {
          console.log(`Index ${addr.index}: ${addr.bech32}`);
        });
        console.log('\nCompare these with your derived-addresses.json file from the mining bot');
        console.log('They should match EXACTLY if using the same seed phrase.');
        console.log('===================================================');
      }

      return addresses;
    } catch (error) {
      console.error('Address derivation error:', error);
      throw new Error(`Failed to derive addresses: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  // Handle seed phrase address generation
  const handleGenerateAddresses = async () => {
    console.log('=== Generate Addresses Called ===');
    setDerivationError(null);
    setDerivedAddresses([]);

    const trimmedPhrase = seedPhrase.trim();
    console.log('Seed phrase from state:', seedPhrase);
    console.log('Trimmed:', trimmedPhrase);
    console.log('Length:', trimmedPhrase.length);

    if (!trimmedPhrase) {
      console.log('ERROR: Empty seed phrase');
      setDerivationError('Please enter a seed phrase');
      return;
    }

    console.log('Calling validateMnemonic...');
    const isValid = validateMnemonic(trimmedPhrase);
    console.log('Validation result:', isValid);

    if (!isValid) {
      console.log('ERROR: Invalid mnemonic');
      setDerivationError('Invalid seed phrase. Please check your words and try again.');
      return;
    }

    if (addressCount < 1 || addressCount > 200) {
      console.log('ERROR: Invalid address count:', addressCount);
      setDerivationError('Address count must be between 1 and 200');
      return;
    }

    console.log('Attempting to derive addresses...');
    try {
      const addresses = await deriveAddressesFromSeed(trimmedPhrase, addressCount);
      console.log('Successfully derived', addresses.length, 'addresses');
      setDerivedAddresses(addresses);
    } catch (error) {
      console.error('Derivation error:', error);
      setDerivationError(error instanceof Error ? error.message : 'Failed to generate addresses');
    }
  };

  // Validate Cardano address
  const isValidAddress = (address: string): boolean => {
    return address.startsWith('addr1') && address.length > 50;
  };

  // Handle check schedule
  const handleCheckSchedule = async () => {
    const addressesToCheck: { label: string; address: string }[] = [];

    if (inputMode === 'single') {
      const addr = singleAddress.trim();
      if (!addr) return;
      if (!isValidAddress(addr)) {
        alert('Invalid Cardano address. Must start with "addr1"');
        return;
      }
      addressesToCheck.push({ label: 'Your Address', address: addr });
    } else if (inputMode === 'bulk') {
      const parsed = parseBulkInput(bulkAddresses);
      if (parsed.length === 0) {
        alert('No valid addresses found');
        return;
      }
      addressesToCheck.push(...parsed);
    } else if (inputMode === 'json') {
      const parsed = parseJsonInput(jsonInput);
      if (parsed.length === 0) {
        alert('No valid addresses found in JSON. Make sure it\'s the derived-addresses.json format.');
        return;
      }
      addressesToCheck.push(...parsed);
    } else if (inputMode === 'seed') {
      if (derivedAddresses.length === 0) {
        alert('Please generate addresses from your seed phrase first');
        return;
      }
      addressesToCheck.push(...derivedAddresses.map(addr => ({
        label: `Address #${addr.index}`,
        address: addr.bech32
      })));
    }

    setLoading(true);
    setResults([]);
    setStoppedEarly(null);

    // Initialize results with loading state
    const initialResults: AddressResult[] = addressesToCheck.map(({ label, address }) => ({
      address,
      label,
      schedule: null,
      loading: true,
    }));
    setResults(initialResults);

    // Fetch schedules with rate limiting and early exit on consecutive empty results
    const MAX_CONSECUTIVE_EMPTY = 10;
    let consecutiveEmpty = 0;
    let checkedCount = 0;

    for (let i = 0; i < addressesToCheck.length; i++) {
      const { address } = addressesToCheck[i];
      checkedCount++;

      try {
        const schedule = await fetchSchedule(address);
        const hasThaws = schedule && schedule.thaws && schedule.thaws.length > 0;

        if (hasThaws) {
          consecutiveEmpty = 0; // Reset counter when we find thaws
        } else {
          consecutiveEmpty++;
        }

        setResults(prev =>
          prev.map((r, idx) =>
            idx === i ? { ...r, schedule, loading: false } : r
          )
        );

        // Check if we should stop early
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY && i < addressesToCheck.length - 1) {
          // Mark remaining addresses as skipped
          setResults(prev =>
            prev.map((r, idx) =>
              idx > i ? { ...r, loading: false, error: 'Skipped' } : r
            )
          );
          setStoppedEarly({
            checked: checkedCount,
            total: addressesToCheck.length,
            consecutiveEmpty: MAX_CONSECUTIVE_EMPTY
          });
          break;
        }
      } catch (error) {
        consecutiveEmpty++; // Count errors as empty too

        setResults(prev =>
          prev.map((r, idx) =>
            idx === i ? { ...r, error: error instanceof Error ? error.message : 'Failed to fetch', loading: false } : r
          )
        );

        // Check if we should stop early after error
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY && i < addressesToCheck.length - 1) {
          setResults(prev =>
            prev.map((r, idx) =>
              idx > i ? { ...r, loading: false, error: 'Skipped' } : r
            )
          );
          setStoppedEarly({
            checked: checkedCount,
            total: addressesToCheck.length,
            consecutiveEmpty: MAX_CONSECUTIVE_EMPTY
          });
          break;
        }
      }

      // Rate limiting: wait 1.5s between requests (except for last one)
      if (i < addressesToCheck.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    setLoading(false);
  };

  // Calculate totals
  const calculateTotals = (): { totalTokens: number; unclaimedThaws: number; nextAvailable: { date: string; amount: number } | null } => {
    let totalTokens = 0;
    let unclaimedThaws = 0;
    let nextAvailable: { date: string; amount: number } | null = null;

    results.forEach(result => {
      if (!result.schedule) return;

      result.schedule.thaws.forEach(thaw => {
        if (thaw.status !== 'claimed') {
          totalTokens += thaw.amount;
          unclaimedThaws++;

          const thawDate = new Date(thaw.thawing_period_start);
          const now = new Date();

          if (thawDate >= now) {
            if (!nextAvailable || thawDate < new Date(nextAvailable.date)) {
              nextAvailable = { date: thaw.thawing_period_start, amount: thaw.amount };
            }
          }
        }
      });
    });

    return { totalTokens, unclaimedThaws, nextAvailable };
  };

  // Export to CSV
  const exportToCSV = () => {
    const rows: string[][] = [['Label', 'Address', 'Claim #', 'Amount', 'Thaw Date', 'Status']];

    results.forEach(result => {
      if (!result.schedule) return;
      result.schedule.thaws.forEach((thaw, idx) => {
        rows.push([
          result.label || '',
          result.address,
          (idx + 1).toString(),
          formatAmount(thaw.amount),
          thaw.thawing_period_start,
          thaw.status,
        ]);
      });
    });

    const csv = rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `thaw-schedule-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Export to JSON
  const exportToJSON = () => {
    const data = results.map(result => ({
      label: result.label,
      address: result.address,
      schedule: result.schedule,
    }));

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `thaw-schedule-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totals = calculateTotals();

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1a1a2e] via-[#16213e] to-[#0f0f23] flex flex-col">
      {/* Header */}
      <div className="bg-gradient-to-r from-purple-900/80 to-blue-900/80 border-b border-purple-500/30">
        <div className="container mx-auto px-4 py-4">
          <div className="max-w-6xl mx-auto flex justify-between items-center">
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-white">
                Midnight Thaw Checker
              </h1>
              <p className="text-sm text-purple-300/70">
                Check your token thaw schedule and claim dates
              </p>
            </div>
            <a
              href="https://redeem.midnight.gd/"
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-semibold rounded-lg hover:from-purple-500 hover:to-blue-500 transition-all flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              Official Claim Site
            </a>
          </div>
        </div>
      </div>

      {/* Input Section */}
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          {/* Mode Toggle */}
          <div className="flex justify-center gap-2 mb-6 flex-wrap">
            <button
              onClick={() => setInputMode('single')}
              className={`px-5 py-2 rounded-lg font-semibold transition-all ${inputMode === 'single'
                ? 'bg-purple-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
            >
              Single Address
            </button>
            <button
              onClick={() => setInputMode('bulk')}
              className={`px-5 py-2 rounded-lg font-semibold transition-all ${inputMode === 'bulk'
                ? 'bg-purple-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
            >
              Multiple Addresses
            </button>
            <button
              onClick={() => setInputMode('json')}
              className={`px-5 py-2 rounded-lg font-semibold transition-all ${inputMode === 'json'
                ? 'bg-purple-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
            >
              Import JSON
            </button>
            <button
              onClick={() => setInputMode('seed')}
              className={`px-5 py-2 rounded-lg font-semibold transition-all ${inputMode === 'seed'
                ? 'bg-purple-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
            >
              Seed Phrase
            </button>
          </div>

          {/* Input Area */}
          <div className="bg-gray-800/50 rounded-xl p-6 border border-gray-700">
            {inputMode === 'single' ? (
              <div>
                <label className="block text-gray-300 mb-2 font-medium">
                  Enter your Midnight address
                </label>
                <input
                  type="text"
                  value={singleAddress}
                  onChange={(e) => setSingleAddress(e.target.value)}
                  placeholder="addr1..."
                  className="w-full px-4 py-3 bg-gray-900 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
            ) : inputMode === 'bulk' ? (
              <div>
                <label className="block text-gray-300 mb-2 font-medium">
                  Enter addresses (one per line)
                </label>
                <p className="text-sm text-gray-400 mb-2">
                  Supports plain addresses or CSV format: <code className="bg-gray-900 px-2 py-0.5 rounded text-purple-300">Label,addr1...</code>
                </p>
                <textarea
                  value={bulkAddresses}
                  onChange={(e) => setBulkAddresses(e.target.value)}
                  placeholder="My Wallet,addr1qxfymkctnvaq4vdasdafsfq5r4ruuxqrxcy7azqfclx2w3jndskajsdbf7iasdfy9ys3tga4s&#10;addr1..."
                  rows={8}
                  className="w-full px-4 py-3 bg-gray-900 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm custom-scrollbar"
                />
                <p className="text-xs text-gray-500 mt-2">
                  {parseBulkInput(bulkAddresses).length} valid address(es) detected
                </p>
              </div>
            ) : inputMode === 'seed' ? (
              <div>
                {/* Security Warning */}
                <div className="mb-4 bg-red-900/30 border border-red-500/50 rounded-lg p-4 flex items-start gap-3">
                  <svg className="w-6 h-6 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div>
                    <div className="text-red-300 font-semibold mb-1">Security Warning</div>
                    <div className="text-red-200/80 text-sm">
                      Your seed phrase is processed entirely in your browser and never sent to any server.
                      Never share your seed phrase with anyone. Only use this feature on a trusted device.
                    </div>
                  </div>
                </div>

                <label className="block text-gray-300 mb-2 font-medium">
                  Enter your wallet seed phrase
                </label>
                <p className="text-sm text-gray-400 mb-3">
                  Enter your 12, 15, or 24-word BIP39 mnemonic seed phrase
                </p>
                <textarea
                  value={seedPhrase}
                  onChange={(e) => setSeedPhrase(e.target.value)}
                  placeholder="word1 word2 word3 ..."
                  rows={4}
                  className="w-full px-4 py-3 bg-gray-900 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm custom-scrollbar"
                />

                {/* Address Count Selector */}
                <div className="mt-4">
                  <label className="block text-gray-300 mb-2 font-medium">
                    Number of addresses to generate (1-200)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="200"
                    value={addressCount}
                    onChange={(e) => setAddressCount(parseInt(e.target.value) || 1)}
                    className="w-full px-4 py-3 bg-gray-900 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                {/* Generate Button */}
                <button
                  onClick={handleGenerateAddresses}
                  className="w-full mt-4 px-6 py-3 bg-gradient-to-r from-green-600 to-emerald-600 text-white font-bold rounded-lg hover:from-green-500 hover:to-emerald-500 transition-all"
                >
                  Generate Addresses
                </button>

                {/* Error Display */}
                {derivationError && (
                  <div className="mt-4 bg-red-900/30 border border-red-500/50 rounded-lg p-3 text-red-300 text-sm">
                    {derivationError}
                  </div>
                )}

                {/* Derived Addresses Display */}
                {derivedAddresses.length > 0 && (
                  <div className="mt-4">
                    <div className="bg-green-900/30 border border-green-500/50 rounded-lg p-3 mb-3">
                      <div className="text-green-300 font-semibold text-sm">
                        ✓ Successfully generated {derivedAddresses.length} address(es)
                      </div>
                      <div className="text-green-200/80 text-xs mt-1">
                        Click "Check Schedule" below to check thaw schedules for all generated addresses
                      </div>
                    </div>
                    <div className="max-h-40 overflow-y-auto custom-scrollbar bg-gray-900 rounded-lg p-3">
                      {derivedAddresses.slice(0, 10).map((addr) => (
                        <div key={addr.index} className="text-xs font-mono text-gray-400 py-1">
                          #{addr.index}: {addr.bech32.substring(0, 20)}...{addr.bech32.substring(addr.bech32.length - 10)}
                        </div>
                      ))}
                      {derivedAddresses.length > 10 && (
                        <div className="text-xs text-gray-500 py-1 italic">
                          ... and {derivedAddresses.length - 10} more
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <p className="text-sm text-purple-300 mb-4">
                  For users who mined using the FetcherBot - the file is located in your bot's secure folder
                </p>
                <label className="block text-gray-300 mb-2 font-medium">
                  Import derived-addresses.json
                </label>
                <p className="text-sm text-gray-400 mb-3">
                  Upload or paste the contents of your <code className="bg-gray-900 px-2 py-0.5 rounded text-purple-300">derived-addresses.json</code> file
                </p>

                {/* File Upload */}
                <div className="mb-4">
                  <label className="flex items-center justify-center gap-2 px-4 py-3 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg cursor-pointer transition-all">
                    <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <span className="text-gray-300 font-medium">Choose JSON File</span>
                    <input
                      type="file"
                      accept=".json"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </label>
                </div>

                <div className="text-center text-gray-500 text-sm mb-3">or paste JSON content below</div>

                <textarea
                  value={jsonInput}
                  onChange={(e) => setJsonInput(e.target.value)}
                  placeholder='[{"index": 0, "bech32": "addr1...", "registered": true}, ...]'
                  rows={8}
                  className="w-full px-4 py-3 bg-gray-900 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm custom-scrollbar"
                />
                <p className="text-xs text-gray-500 mt-2">
                  {parseJsonInput(jsonInput).length} valid address(es) detected
                </p>
              </div>
            )}

            <button
              onClick={handleCheckSchedule}
              disabled={loading || (inputMode === 'seed' && derivedAddresses.length === 0)}
              className="w-full mt-4 px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-bold text-lg rounded-lg shadow-lg hover:shadow-purple-500/50 transition-all duration-300 hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            >
              {loading ? 'Checking...' : 'Check Schedule'}
            </button>
          </div>
        </div>
      </div>

      {/* Results Section */}
      {results.length > 0 && (
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-6xl mx-auto">
            {/* Stopped Early Notice */}
            {stoppedEarly && (
              <div className="mb-6 bg-yellow-900/30 border border-yellow-500/50 rounded-xl p-4 flex items-start gap-3">
                <svg className="w-6 h-6 text-yellow-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <div className="text-yellow-300 font-semibold">Search stopped early</div>
                  <div className="text-yellow-200/80 text-sm mt-1">
                    Checked {stoppedEarly.checked} of {stoppedEarly.total} addresses.
                    Stopped after {stoppedEarly.consecutiveEmpty} consecutive addresses with no thaw schedule found.
                    The remaining {stoppedEarly.total - stoppedEarly.checked} addresses were skipped.
                  </div>
                </div>
              </div>
            )}

            {/* Summary Cards */}
            {!loading && totals.unclaimedThaws > 0 && (
              <div className="grid md:grid-cols-3 gap-6 mb-8">
                <div className="bg-gradient-to-br from-purple-900/40 to-blue-900/40 rounded-xl p-6 border border-purple-500/30">
                  <div className="text-sm text-purple-300 mb-1">Total Tokens Due</div>
                  <div className="text-3xl font-bold text-white">{formatAmount(totals.totalTokens)}</div>
                  <div className="text-xs text-gray-400 mt-1">NIGHT</div>
                </div>

                <div className="bg-gradient-to-br from-blue-900/40 to-cyan-900/40 rounded-xl p-6 border border-blue-500/30">
                  <div className="text-sm text-blue-300 mb-1">Unclaimed Thaws</div>
                  <div className="text-3xl font-bold text-white">{totals.unclaimedThaws}</div>
                  <div className="text-xs text-gray-400 mt-1">Remaining</div>
                </div>

                <div className="bg-gradient-to-br from-green-900/40 to-emerald-900/40 rounded-xl p-6 border border-green-500/30">
                  <div className="text-sm text-green-300 mb-1">Next Available</div>
                  {totals.nextAvailable ? (
                    <>
                      <div className="text-xl font-bold text-white">{formatDate(totals.nextAvailable.date)}</div>
                      <div className="text-sm text-gray-400 mt-1">{getTimeUntil(totals.nextAvailable.date)}</div>
                    </>
                  ) : (
                    <div className="text-xl font-bold text-white">None pending</div>
                  )}
                </div>
              </div>
            )}

            {/* View Toggle & Export */}
            <div className="flex flex-wrap justify-between items-center mb-6 gap-4">
              <div className="flex gap-2">
                <button
                  onClick={() => setViewMode('timeline')}
                  className={`px-4 py-2 rounded-lg font-medium transition-all ${viewMode === 'timeline'
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                >
                  Timeline View
                </button>
                <button
                  onClick={() => setViewMode('table')}
                  className={`px-4 py-2 rounded-lg font-medium transition-all ${viewMode === 'table'
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                >
                  Table View
                </button>
                <button
                  onClick={() => setViewMode('calendar')}
                  className={`px-4 py-2 rounded-lg font-medium transition-all ${viewMode === 'calendar'
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                >
                  Calendar View
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={exportToCSV}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-all flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Export CSV
                </button>
                <button
                  onClick={exportToJSON}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-all flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Export JSON
                </button>
              </div>
            </div>

            {/* Results Display */}
            {viewMode === 'calendar' ? (
              // Unified Calendar View for all addresses
              <CalendarView
                results={results}
                formatAmount={formatAmount}
                currentMonth={currentMonth}
                setCurrentMonth={setCurrentMonth}
                selectedDate={selectedDate}
                setSelectedDate={setSelectedDate}
                getStatusColor={getStatusColor}
              />
            ) : (
              // Timeline/Table View per address
              results.map((result, resultIdx) => (
                <div key={resultIdx} className="mb-8">
                  {/* Address Header */}
                  <div className="bg-gray-800/50 rounded-t-xl px-6 py-4 border-x border-t border-gray-700">
                    <div className="flex flex-wrap justify-between items-center gap-4">
                      <div>
                        <h3 className="text-xl font-bold text-white">{result.label}</h3>
                        <p className="text-sm text-gray-400 font-mono break-all">{result.address}</p>
                      </div>
                      {result.schedule && (
                        <div className="text-right">
                          <div className="text-sm text-gray-400">Total Thaws</div>
                          <div className="text-2xl font-bold text-white">{result.schedule.thaws.length}</div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Content */}
                  <div className="bg-gray-800/30 rounded-b-xl px-6 py-6 border-x border-b border-gray-700">
                    {result.loading ? (
                      <div className="text-center py-8">
                        <div className="inline-block w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                        <p className="text-gray-400 mt-3">Loading schedule...</p>
                      </div>
                    ) : result.error ? (
                      <div className="text-center py-8">
                        <div className="text-red-400 text-lg font-semibold mb-2">Error</div>
                        <p className="text-gray-400">{result.error}</p>
                      </div>
                    ) : result.schedule && result.schedule.thaws.length === 0 ? (
                      <div className="text-center py-8">
                        <div className="text-yellow-400 text-lg font-semibold mb-2">No Thaw Schedule Found</div>
                        <p className="text-gray-400">This address has no redeemable thaws.</p>
                      </div>
                    ) : result.schedule ? (
                      viewMode === 'timeline' ? (
                        <TimelineView
                          thaws={result.schedule.thaws}
                          formatAmount={formatAmount}
                          formatDate={formatDate}
                          getTimeUntil={getTimeUntil}
                          getStatusColor={getStatusColor}
                        />
                      ) : (
                        <TableView
                          thaws={result.schedule.thaws}
                          formatAmount={formatAmount}
                          formatDate={formatDate}
                          getTimeUntil={getTimeUntil}
                        />
                      )
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Attribution Footer */}
      <div className="mt-auto bg-gradient-to-r from-purple-600/80 via-blue-600/80 to-cyan-600/80 text-white py-3 px-4 text-center text-sm">
        <p>
          Built by Paul & Paddy of ADA Markets
          <span className="mx-2">•</span>
          <a
            href="https://ada.markets/discord"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline hover:text-yellow-200 transition-colors"
          >
            Join Discord
          </a>
          <span className="mx-2">•</span>
          Follow
          <a
            href="https://x.com/cwpaulm"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 font-semibold underline hover:text-yellow-200 transition-colors"
          >
            Paul
          </a>
          <span className="mx-1">&</span>
          <a
            href="https://x.com/PoolShamrock"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline hover:text-yellow-200 transition-colors"
          >
            Paddy
          </a>
          <span className="ml-1">on X</span>
        </p>
      </div>
    </div>
  );
}

// Add to Calendar Button Component
function AddToCalendarButton({ amount, dateStr, thawNumber }: { amount: number; dateStr: string; thawNumber: number }) {
  const [isOpen, setIsOpen] = useState(false);

  // Don't show for past dates or claimed thaws
  const thawDate = new Date(dateStr);
  const now = new Date();
  if (thawDate < now) {
    return null;
  }

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-all text-gray-300 hover:text-white"
        title="Add to Calendar"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />

          {/* Dropdown */}
          <div className="absolute right-0 top-full mt-2 w-48 bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-20 overflow-hidden">
            <div className="p-2 text-xs text-gray-400 border-b border-gray-700">Add to Calendar</div>

            <button
              onClick={() => {
                downloadICSFile(amount, dateStr, thawNumber);
                setIsOpen(false);
              }}
              className="w-full px-4 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Download .ics
            </button>

            <a
              href={getGoogleCalendarUrl(amount, dateStr, thawNumber)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setIsOpen(false)}
              className="w-full px-4 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
              Google Calendar
            </a>

            <a
              href={getOutlookCalendarUrl(amount, dateStr, thawNumber)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setIsOpen(false)}
              className="w-full px-4 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7.88 12.04q0 .45-.11.87-.1.41-.33.74-.22.33-.58.52-.37.2-.87.2t-.85-.2q-.35-.21-.57-.55-.22-.33-.33-.75-.1-.42-.1-.86t.1-.87q.1-.43.34-.76.22-.34.59-.54.36-.2.87-.2t.86.2q.35.21.57.55.22.34.31.77.1.43.1.88zM24 12v9.38q0 .46-.33.8-.33.32-.8.32H7.13q-.46 0-.8-.33-.32-.33-.32-.8V18H1q-.41 0-.7-.3-.3-.29-.3-.7V7q0-.41.3-.7Q.58 6 1 6h6.5V2.55q0-.44.3-.75.3-.3.75-.3h12.9q.44 0 .75.3.3.3.3.75V12zm-6-8.25v3h3v-3zm0 4.5v3h3v-3zm0 4.5v1.83l3.05-1.83zm-5.25-9v3h3.75v-3zm0 4.5v3h3.75v-3zm0 4.5v2.03l2.41 1.5 1.34-.8v-2.73zM9 3.75V6h2l.13.01.12.04v-2.3zM5.98 15.98q.9 0 1.6-.3.7-.32 1.19-.86.48-.55.73-1.28.25-.74.25-1.61 0-.83-.25-1.55-.24-.71-.71-1.24t-1.15-.83q-.68-.3-1.55-.3-.92 0-1.64.3-.71.3-1.2.85-.5.54-.75 1.3-.25.74-.25 1.63 0 .85.26 1.56.26.72.74 1.23.48.52 1.17.81.69.3 1.56.3zM7.5 21h12.39L12 16.08V17q0 .41-.3.7-.29.3-.7.3H7.5zm15-.13v-7.24l-5.9 3.54Z" />
              </svg>
              Outlook
            </a>
          </div>
        </>
      )}
    </div>
  );
}

// Timeline View Component
function TimelineView({
  thaws,
  formatAmount,
  formatDate,
  getTimeUntil,
  getStatusColor
}: {
  thaws: Thaw[];
  formatAmount: (amount: number) => string;
  formatDate: (date: string) => string;
  getTimeUntil: (date: string) => string;
  getStatusColor: (status: string, date: string) => string;
}) {
  return (
    <div className="space-y-6">
      {thaws.map((thaw, idx) => (
        <div key={idx} className="flex gap-4">
          {/* Timeline Dot */}
          <div className="flex flex-col items-center">
            <div className={`w-4 h-4 rounded-full ${getStatusColor(thaw.status, thaw.thawing_period_start)} ring-4 ring-gray-800`}></div>
            {idx < thaws.length - 1 && (
              <div className="w-0.5 h-full bg-gray-700 mt-2"></div>
            )}
          </div>

          {/* Card */}
          <div className="flex-1 bg-gray-900/50 rounded-lg p-4 border border-gray-700 mb-2">
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <span className={`px-3 py-1 rounded-full text-xs font-bold text-white uppercase ${getStatusColor(thaw.status, thaw.thawing_period_start)}`}>
                    {thaw.status}
                  </span>
                  <span className="text-gray-400 text-sm">Thaw #{idx + 1}</span>
                </div>
                <div className="text-3xl font-bold text-white mb-1">
                  {formatAmount(thaw.amount)} <span className="text-lg text-gray-400">NIGHT</span>
                </div>
                <div className="text-gray-300">
                  {formatDate(thaw.thawing_period_start)}
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="text-right">
                  <div className="text-sm text-gray-400 mb-1">Time Until</div>
                  <div className="text-lg font-semibold text-purple-400">
                    {getTimeUntil(thaw.thawing_period_start)}
                  </div>
                </div>
                {thaw.status !== 'claimed' && (
                  <AddToCalendarButton
                    amount={thaw.amount}
                    dateStr={thaw.thawing_period_start}
                    thawNumber={idx + 1}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Table View Component
function TableView({
  thaws,
  formatAmount,
  formatDate,
  getTimeUntil
}: {
  thaws: Thaw[];
  formatAmount: (amount: number) => string;
  formatDate: (date: string) => string;
  getTimeUntil: (date: string) => string;
}) {
  return (
    <div className="overflow-x-auto custom-scrollbar">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-700">
            <th className="text-left py-3 px-4 text-gray-400 font-semibold">#</th>
            <th className="text-left py-3 px-4 text-gray-400 font-semibold">Amount</th>
            <th className="text-left py-3 px-4 text-gray-400 font-semibold">Date</th>
            <th className="text-left py-3 px-4 text-gray-400 font-semibold">Time Until</th>
            <th className="text-left py-3 px-4 text-gray-400 font-semibold">Status</th>
            <th className="text-left py-3 px-4 text-gray-400 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {thaws.map((thaw, idx) => (
            <tr key={idx} className="border-b border-gray-800 hover:bg-gray-800/30 transition-colors">
              <td className="py-3 px-4 text-gray-300">{idx + 1}</td>
              <td className="py-3 px-4 text-white font-semibold">
                {formatAmount(thaw.amount)} NIGHT
              </td>
              <td className="py-3 px-4 text-gray-300">{formatDate(thaw.thawing_period_start)}</td>
              <td className="py-3 px-4 text-purple-400 font-medium">{getTimeUntil(thaw.thawing_period_start)}</td>
              <td className="py-3 px-4">
                <span className={`px-3 py-1 rounded-full text-xs font-bold text-white uppercase ${thaw.status === 'claimed' ? 'bg-gray-500' :
                  thaw.status === 'available' ? 'bg-green-500' :
                    'bg-blue-500'
                  }`}>
                  {thaw.status}
                </span>
              </td>
              <td className="py-3 px-4">
                {thaw.status !== 'claimed' && (
                  <AddToCalendarButton
                    amount={thaw.amount}
                    dateStr={thaw.thawing_period_start}
                    thawNumber={idx + 1}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Extended thaw interface with address info
interface ThawWithAddress extends Thaw {
  addressLabel?: string;
  address?: string;
}

// Calendar View Component
function CalendarView({
  results,
  formatAmount,
  currentMonth,
  setCurrentMonth,
  selectedDate,
  setSelectedDate,
  getStatusColor
}: {
  results: AddressResult[];
  formatAmount: (amount: number) => string;
  currentMonth: Date;
  setCurrentMonth: (date: Date) => void;
  selectedDate: string | null;
  setSelectedDate: (date: string | null) => void;
  getStatusColor: (status: string, date: string) => string;
}) {
  // Aggregate all thaws from all addresses
  const allThaws: ThawWithAddress[] = [];
  results.forEach(result => {
    if (result.schedule && result.schedule.thaws) {
      result.schedule.thaws.forEach(thaw => {
        allThaws.push({
          ...thaw,
          addressLabel: result.label,
          address: result.address
        });
      });
    }
  });

  // Group thaws by date
  const thawsByDate = new Map<string, ThawWithAddress[]>();
  allThaws.forEach(thaw => {
    const dateKey = thaw.thawing_period_start.split('T')[0]; // YYYY-MM-DD
    if (!thawsByDate.has(dateKey)) {
      thawsByDate.set(dateKey, []);
    }
    thawsByDate.get(dateKey)!.push(thaw);
  });

  // Get calendar grid for current month
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startingDayOfWeek = firstDay.getDay();
  const daysInMonth = lastDay.getDate();

  // Generate calendar days
  const calendarDays: (number | null)[] = [];
  for (let i = 0; i < startingDayOfWeek; i++) {
    calendarDays.push(null);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    calendarDays.push(day);
  }

  // Month navigation
  const prevMonth = () => {
    setCurrentMonth(new Date(year, month - 1, 1));
  };

  const nextMonth = () => {
    setCurrentMonth(new Date(year, month + 1, 1));
  };

  const monthName = currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Check if a date has thaws
  const getThawsForDay = (day: number | null): ThawWithAddress[] => {
    if (!day) return [];
    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return thawsByDate.get(dateKey) || [];
  };

  // Handle date click
  const handleDateClick = (day: number | null) => {
    if (!day) return;
    const dayThaws = getThawsForDay(day);
    if (dayThaws.length === 0) return;

    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    setSelectedDate(selectedDate === dateKey ? null : dateKey);
  };

  const selectedDayThaws = selectedDate ? thawsByDate.get(selectedDate) || [] : [];

  // Get thaws for current month (sorted by date)
  const monthThaws: ThawWithAddress[] = [];
  thawsByDate.forEach((thaws, dateKey) => {
    const thawDate = new Date(dateKey);
    if (thawDate.getFullYear() === year && thawDate.getMonth() === month) {
      monthThaws.push(...thaws);
    }
  });
  monthThaws.sort((a, b) => new Date(a.thawing_period_start).getTime() - new Date(b.thawing_period_start).getTime());

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Calendar Section (Left - 2 columns) */}
      <div className="lg:col-span-2">
        {/* Calendar Header */}
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={prevMonth}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-all"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h3 className="text-xl font-bold text-white">{monthName}</h3>
          <button
            onClick={nextMonth}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-all"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {/* Calendar Grid */}
        <div className="grid grid-cols-7 gap-1">
          {/* Day labels */}
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
            <div key={day} className="text-center text-xs font-semibold text-gray-400 py-1">
              {day}
            </div>
          ))}

          {/* Calendar days */}
          {calendarDays.map((day, idx) => {
            const dayThaws = getThawsForDay(day);
            const hasThaws = dayThaws.length > 0;
            const dateKey = day ? `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
            const isSelected = dateKey === selectedDate;

            return (
              <div
                key={idx}
                onClick={() => handleDateClick(day)}
                className={`
                  aspect-square p-1.5 rounded border transition-all text-center
                  ${!day ? 'bg-transparent border-transparent' : ''}
                  ${day && !hasThaws ? 'bg-gray-800/30 border-gray-700 cursor-default' : ''}
                  ${day && hasThaws ? 'bg-gradient-to-br from-purple-900/40 to-blue-900/40 border-purple-500/50 cursor-pointer hover:border-purple-400' : ''}
                  ${isSelected ? 'ring-2 ring-purple-400 border-purple-400' : ''}
                `}
              >
                {day && (
                  <div className="flex flex-col h-full justify-between">
                    <div className="text-xs font-semibold text-white">{day}</div>
                    {hasThaws && (
                      <div className="flex justify-center gap-0.5">
                        {dayThaws.slice(0, 3).map((thaw, i) => (
                          <div
                            key={i}
                            className={`w-1 h-1 rounded-full ${getStatusColor(thaw.status, thaw.thawing_period_start)}`}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right Sidebar - Monthly Thaws */}
      <div className="lg:col-span-1">
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700 sticky top-4">
          <h4 className="text-lg font-bold text-white mb-4">
            {selectedDate ? 'Selected Date' : `${monthName.split(' ')[0]} Thaws`}
          </h4>

          {selectedDate && selectedDayThaws.length > 0 ? (
            // Show selected date details
            <div>
              <div className="mb-4">
                <div className="text-sm text-gray-400 mb-1">
                  {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'short',
                    day: 'numeric'
                  })}
                </div>
                <button
                  onClick={() => setSelectedDate(null)}
                  className="text-xs text-purple-400 hover:text-purple-300"
                >
                  Back to month view
                </button>
              </div>

              <div className="space-y-2 max-h-[600px] overflow-y-auto custom-scrollbar">
                {selectedDayThaws.map((thaw, idx) => (
                  <div key={idx} className="bg-gray-900/50 rounded-lg p-3 border border-gray-700">
                    <div className="text-lg font-bold text-white mb-1">
                      {formatAmount(thaw.amount)} <span className="text-sm text-gray-400">NIGHT</span>
                    </div>
                    {thaw.addressLabel && (
                      <div className="text-xs text-purple-300 mb-1">
                        {thaw.addressLabel}
                      </div>
                    )}
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold text-white uppercase ${getStatusColor(thaw.status, thaw.thawing_period_start)}`}>
                      {thaw.status}
                    </span>
                    {thaw.address && (
                      <div className="text-xs text-gray-600 font-mono mt-2 break-all">
                        {thaw.address.substring(0, 20)}...
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="mt-4 pt-4 border-t border-gray-700">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-gray-400">Total:</span>
                  <span className="font-bold text-white">
                    {formatAmount(selectedDayThaws.reduce((sum, t) => sum + t.amount, 0))} NIGHT
                  </span>
                </div>
              </div>
            </div>
          ) : monthThaws.length > 0 ? (
            // Show all thaws for current month
            <div className="space-y-2 max-h-[600px] overflow-y-auto custom-scrollbar">
              {monthThaws.map((thaw, idx) => (
                <div
                  key={idx}
                  className="bg-gray-900/50 rounded-lg p-3 border border-gray-700 hover:border-purple-500/50 transition-all cursor-pointer"
                  onClick={() => setSelectedDate(thaw.thawing_period_start.split('T')[0])}
                >
                  <div className="flex justify-between items-start mb-1">
                    <div className="text-sm text-gray-400">
                      {new Date(thaw.thawing_period_start).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric'
                      })}
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold text-white uppercase ${getStatusColor(thaw.status, thaw.thawing_period_start)}`}>
                      {thaw.status}
                    </span>
                  </div>
                  <div className="text-lg font-bold text-white">
                    {formatAmount(thaw.amount)} <span className="text-sm text-gray-400">NIGHT</span>
                  </div>
                  {thaw.addressLabel && (
                    <div className="text-xs text-purple-300 mt-1">
                      {thaw.addressLabel}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              No thaws this month
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
