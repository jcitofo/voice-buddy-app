
import React from 'react';

interface StatsCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
}

const StatsCard: React.FC<StatsCardProps> = ({ label, value, icon }) => {
  return (
    <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-4">
      <div className="bg-blue-50 p-3 rounded-lg text-blue-600">
        {icon}
      </div>
      <div>
        <p className="text-sm text-slate-500 font-medium">{label}</p>
        <p className="text-xl font-bold text-slate-900">{value}</p>
      </div>
    </div>
  );
};

export default StatsCard;
