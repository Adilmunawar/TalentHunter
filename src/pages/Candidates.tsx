import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, FileText, Mail, Phone, MapPin, Briefcase, ExternalLink, Trash2 } from 'lucide-react';
import { Tables } from '@/integrations/supabase/types';
import Footer from '@/components/Footer';

type Profile = Tables<'profiles'>;

export default function Candidates() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [filteredProfiles, setFilteredProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedJobTitle, setSelectedJobTitle] = useState<string>('all');
  const [jobTitles, setJobTitles] = useState<string[]>([]);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [duplicateIds, setDuplicateIds] = useState<string[]>([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [deletingDuplicates, setDeletingDuplicates] = useState(false);

  useEffect(() => {
    fetchProfiles();
  }, []);

  useEffect(() => {
    filterProfiles();
  }, [profiles, searchTerm, selectedJobTitle]);

  const fetchProfiles = async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      setProfiles(data || []);
      
      // Extract unique job titles for filter
      const uniqueTitles = Array.from(
        new Set(data?.map(p => p.job_title).filter(Boolean) as string[])
      );
      setJobTitles(uniqueTitles);
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to fetch candidates',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const filterProfiles = () => {
    let filtered = profiles;

    // Filter by search term
    if (searchTerm) {
      filtered = filtered.filter(profile =>
        profile.full_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        profile.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        profile.phone_number?.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    // Filter by job title
    if (selectedJobTitle !== 'all') {
      filtered = filtered.filter(profile => profile.job_title === selectedJobTitle);
    }

    setFilteredProfiles(filtered);
  };

  const handleViewResume = (resumeUrl: string | null) => {
    if (!resumeUrl) {
      toast({
        title: 'No Resume',
        description: 'This candidate does not have a resume file uploaded',
        variant: 'destructive',
      });
      return;
    }
    window.open(resumeUrl, '_blank');
  };

  const findDuplicates = () => {
    setCheckingDuplicates(true);
    
    // Find duplicates based on email or phone number
    const duplicateMap = new Map<string, Profile[]>();
    
    profiles.forEach(profile => {
      // Create a key based on email or phone (whichever exists)
      const key = profile.email || profile.phone_number;
      if (key) {
        if (!duplicateMap.has(key)) {
          duplicateMap.set(key, []);
        }
        duplicateMap.get(key)!.push(profile);
      }
    });

    // Filter out entries with only one profile (not duplicates)
    const duplicates: string[] = [];
    duplicateMap.forEach((profileList, key) => {
      if (profileList.length > 1) {
        // Sort by created_at, keep the newest one, mark others for deletion
        const sortedProfiles = profileList.sort((a, b) => 
          new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
        );
        // Add all except the first (newest) to the deletion list
        sortedProfiles.slice(1).forEach(p => duplicates.push(p.id));
      }
    });

    setDuplicateIds(duplicates);
    setDuplicateCount(duplicates.length);
    setCheckingDuplicates(false);

    if (duplicates.length === 0) {
      toast({
        title: 'No Duplicates Found',
        description: 'All candidate profiles are unique',
      });
    } else {
      setShowDeleteDialog(true);
    }
  };

  const handleDeleteDuplicates = async () => {
    setDeletingDuplicates(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .delete()
        .in('id', duplicateIds);

      if (error) throw error;

      toast({
        title: 'Success',
        description: `Deleted ${duplicateCount} duplicate profile(s)`,
      });

      // Refresh the list
      await fetchProfiles();
      setShowDeleteDialog(false);
      setDuplicateIds([]);
      setDuplicateCount(0);
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to delete duplicates',
        variant: 'destructive',
      });
    } finally {
      setDeletingDuplicates(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-muted/20 to-primary/5 flex flex-col">
      <div className="container mx-auto px-4 py-8 flex-1">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              onClick={() => navigate('/')}
              className="gap-2"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <h1 className="text-4xl font-bold text-foreground">All Candidates</h1>
          </div>
          <Button
            variant="destructive"
            onClick={findDuplicates}
            disabled={checkingDuplicates || profiles.length === 0}
            className="gap-2"
          >
            <Trash2 className="h-4 w-4" />
            {checkingDuplicates ? 'Checking...' : 'Delete Duplicates'}
          </Button>
        </div>

        {/* Filters */}
        <Card className="p-6 mb-8 bg-card/50 backdrop-blur-sm">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1">
              <Input
                placeholder="Search by name, email, or phone..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full"
              />
            </div>
            <Select value={selectedJobTitle} onValueChange={setSelectedJobTitle}>
              <SelectTrigger className="w-full md:w-64">
                <SelectValue placeholder="Filter by job title" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Job Titles</SelectItem>
                {jobTitles.map((title) => (
                  <SelectItem key={title} value={title}>
                    {title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-4 text-sm text-muted-foreground">
            Showing {filteredProfiles.length} of {profiles.length} candidates
          </div>
        </Card>

        {/* Candidates List */}
        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
            <p className="mt-4 text-muted-foreground">Loading candidates...</p>
          </div>
        ) : filteredProfiles.length === 0 ? (
          <Card className="p-12 text-center">
            <FileText className="h-16 w-16 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-xl font-semibold mb-2">No Candidates Found</h3>
            <p className="text-muted-foreground">
              {profiles.length === 0
                ? 'Upload some resumes to get started'
                : 'Try adjusting your filters'}
            </p>
          </Card>
        ) : (
          <div className="grid gap-4">
            {filteredProfiles.map((profile) => (
              <Card
                key={profile.id}
                className="p-6 hover:shadow-lg transition-all duration-300 bg-card/50 backdrop-blur-sm border-2 hover:border-primary/50"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex-1 space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-primary/10 rounded-lg">
                        <FileText className="h-5 w-5 text-primary" />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-xl font-bold text-foreground">
                          {profile.full_name || 'Unknown'}
                        </h3>
                        {profile.job_title && (
                          <div className="flex items-center gap-2 mt-1">
                            <Briefcase className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">
                              {profile.job_title}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="grid md:grid-cols-2 gap-2 text-sm">
                      {profile.email && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Mail className="h-4 w-4" />
                          <span>{profile.email}</span>
                        </div>
                      )}
                      {profile.phone_number && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Phone className="h-4 w-4" />
                          <span>{profile.phone_number}</span>
                        </div>
                      )}
                      {profile.location && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <MapPin className="h-4 w-4" />
                          <span>{profile.location}</span>
                        </div>
                      )}
                      {profile.years_of_experience && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Briefcase className="h-4 w-4" />
                          <span>{profile.years_of_experience} years experience</span>
                        </div>
                      )}
                    </div>

                    {profile.skills && profile.skills.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {profile.skills.slice(0, 5).map((skill, idx) => (
                          <span
                            key={idx}
                            className="px-3 py-1 bg-primary/10 text-primary rounded-full text-xs font-medium"
                          >
                            {skill}
                          </span>
                        ))}
                        {profile.skills.length > 5 && (
                          <span className="px-3 py-1 bg-muted text-muted-foreground rounded-full text-xs font-medium">
                            +{profile.skills.length - 5} more
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex md:flex-col gap-2">
                    <Button
                      onClick={() => handleViewResume(profile.resume_file_url)}
                      className="gap-2 whitespace-nowrap"
                      disabled={!profile.resume_file_url}
                    >
                      <ExternalLink className="h-4 w-4" />
                      View Resume
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Duplicate Candidates?</AlertDialogTitle>
            <AlertDialogDescription>
              {duplicateCount} duplicate candidate profile(s) will be permanently deleted. 
              This action cannot be undone.
              <br /><br />
              <strong>Note:</strong> For candidates with the same email or phone number, 
              only the most recently uploaded profile will be kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingDuplicates}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteDuplicates}
              disabled={deletingDuplicates}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingDuplicates ? 'Deleting...' : `Delete ${duplicateCount} Profile(s)`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Footer />
    </div>
  );
}
