import { exec as exaca } from 'node:child_process';
import { promisify } from 'node:util';
import * as si from 'systeminformation';
import { PLATFORM_IS_WINDOWS } from '../../utils';

const exec = promisify(exaca);

type Block = si.Systeminformation.BlockDevicesData;

export const getEnhancedBlocks = async (): Promise<Block[]> => {
  const blocks = await si.blockDevices();
  if (PLATFORM_IS_WINDOWS) {
    return blocks;
  }

  try {
    const { stdout } = await exec('lsblk -bPo NAME,PKNAME 2>/dev/null');
    const parentMap: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
      const nameMatch = line.match(/NAME="([^"]+)"/);
      const pkMatch = line.match(/PKNAME="([^"]+)"/);
      if (nameMatch) {
        parentMap[nameMatch[1]] = pkMatch ? pkMatch[1] : '';
      }
    }

    const findRootDisk = (name: string): string => {
      let curr = name;
      const seen = new Set<string>();
      while (parentMap[curr] && !seen.has(curr)) {
        seen.add(curr);
        curr = parentMap[curr];
      }
      return curr;
    };

    for (const block of blocks) {
      const rootDisk = findRootDisk(block.name);
      if (rootDisk && rootDisk !== block.name) {
        if (!block.device || block.device === '') {
          block.device = `/dev/${rootDisk}`;
        }
      }
    }
  } catch {
    // If lsblk fails or is unavailable, return raw blocks
  }

  return blocks;
};
