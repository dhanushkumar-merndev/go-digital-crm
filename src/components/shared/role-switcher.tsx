'use client';

import { useRouter } from 'next/navigation';
import { roleKeys, roleNavigation } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function RoleSwitcher({ role }: { role: RoleKey }) {
  const router = useRouter();
  return (
    <Select value={role} onValueChange={(value) => router.push(`/${value}/dashboard`)}>
      <SelectTrigger className="h-9 border-white/15 bg-white/5 text-white focus:ring-white/30">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roleKeys.map((key) => (
          <SelectItem value={key} key={key}>
            {roleNavigation[key].shortLabel}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
